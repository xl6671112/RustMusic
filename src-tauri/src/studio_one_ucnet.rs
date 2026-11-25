//! Studio One's local Remote client: subscribe to the host mixer, not VST factories.
use super::StudioOneChannel;
use flate2::read::ZlibDecoder;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    sync::Mutex,
    time::{Duration, Instant},
};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
};

const LIMIT: usize = 8 * 1024 * 1024;
const CONTROL_CONFIRM_TIMEOUT: Duration = Duration::from_millis(800);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static RETRY: Mutex<Option<(u32, Instant, Route)>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    StudioOne,
    StudioPro,
}

impl Route {
    fn ids(self) -> (u16, u16) {
        match self {
            Self::StudioOne => (103, 105),
            Self::StudioPro => (104, 103),
        }
    }

    fn other(self) -> Self {
        match self {
            Self::StudioOne => Self::StudioPro,
            Self::StudioPro => Self::StudioOne,
        }
    }
}

struct Session {
    pid: u32,
    opened: Instant,
    route: Route,
    socket: TcpStream,
    _udp: UdpSocket,
    buffer: Vec<u8>,
    chunks: Vec<u8>,
    mixer: Option<Vec<StudioOneChannel>>,
}

fn port_for_pid(pid: u32) -> Option<u16> {
    let mut size = 0;
    unsafe { GetExtendedTcpTable(None, &mut size, false, 2, TCP_TABLE_OWNER_PID_LISTENER, 0) };
    if !(4..=LIMIT as u32).contains(&size) {
        return None;
    }
    let mut table = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe {
        GetExtendedTcpTable(
            Some(table.as_mut_ptr().cast()),
            &mut size,
            false,
            2,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    } != 0
    {
        return None;
    }
    // Count followed by six DWORD fields per MIB_TCPROW_OWNER_PID.
    let mut ports = table[1..]
        .chunks_exact(6)
        .take(table[0] as usize)
        .filter(|row| row[5] == pid && (row[1] == 0 || row[1].to_ne_bytes() == [127, 0, 0, 1]))
        .map(|row| u16::from_be(row[2] as u16))
        .collect::<Vec<_>>();
    ports.sort_unstable();
    ports.dedup();
    match ports.as_slice() {
        [port] if *port != 0 => Some(*port),
        _ => None,
    }
}

fn frame(kind: &[u8; 2], source: u16, destination: u16, payload: &[u8]) -> Vec<u8> {
    let mut bytes = b"UC\0\x01".to_vec();
    bytes.extend_from_slice(&((6 + payload.len()) as u16).to_le_bytes());
    bytes.extend_from_slice(kind);
    bytes.extend_from_slice(&source.to_le_bytes());
    bytes.extend_from_slice(&destination.to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

impl Session {
    fn connect(pid: u32, route: Route) -> Option<Self> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port_for_pid(pid)?));
        let mut socket = TcpStream::connect_timeout(&address, Duration::from_millis(250)).ok()?;
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
        socket
            .set_write_timeout(Some(Duration::from_millis(150)))
            .ok()?;
        let j = serde_json::to_vec(&json!({
            "id": "Subscribe", "clientName": "RustMusic", "clientInternalName": "dawremote",
            "clientDescription": "RustMusic Streamer Console", "clientType": "PC",
            "clientIdentifier": format!("{:032x}", rand::random::<u128>()),
            "clientOptions": "surround", "clientEncoding": 0x5a4d,
        }))
        .ok()?;
        let mut subscription = (j.len() as u32).to_le_bytes().to_vec();
        subscription.extend_from_slice(&j);
        let (client, host) = route.ids();
        let mut hello = frame(b"UM", 0, host, &udp.local_addr().ok()?.port().to_le_bytes());
        hello.extend(frame(b"JM", client, host, &subscription));
        hello.extend(frame(b"KA", client, host, &[]));
        socket.write_all(&hello).ok()?;
        socket.set_nonblocking(true).ok()?;
        Some(Self {
            pid,
            socket,
            route,
            _udp: udp,
            opened: Instant::now(),
            buffer: Vec::new(),
            chunks: Vec::new(),
            mixer: None,
        })
    }

    fn send(&mut self, kind: &[u8; 2], data: &[u8]) -> std::io::Result<()> {
        let (client, host) = self.route.ids();
        self.socket.write_all(&frame(kind, client, host, data))
    }

    fn pump(&mut self) -> Option<()> {
        let mut bytes = [0u8; 16384];
        for _ in 0..128 {
            match self.socket.read(&mut bytes) {
                Ok(0) => return None,
                Ok(n) => self.buffer.extend_from_slice(&bytes[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return None,
            }
            let mut consumed = 0;
            while self.buffer.len() >= consumed + 6 {
                let head = &self.buffer[consumed..];
                if &head[..4] != b"UC\0\x01" {
                    return None;
                }
                let size = u16::from_le_bytes([head[4], head[5]]) as usize;
                if size < 6 {
                    return None;
                }
                if head.len() < 6 + size {
                    break;
                }
                let body = &head[12..6 + size];
                match &head[6..8] {
                    b"ZM" if body.len() >= 4 => {
                        if let Some(rows) = compressed_mixer(&body[4..]) {
                            self.mixer = Some(rows);
                        }
                    }
                    b"PV" => {
                        if let Some(rows) = self.mixer.as_mut() {
                            apply_parameter(rows, body);
                        }
                    }
                    b"CK" if body.len() >= 16 && &body[2..4] == b"ZM" => {
                        let word =
                            |i| u32::from_le_bytes(body[i..i + 4].try_into().unwrap()) as usize;
                        let (offset, total, length) = (word(4), word(8), word(12));
                        if offset == 0 {
                            self.chunks.clear();
                        }
                        if total <= LIMIT
                            && offset == self.chunks.len()
                            && length == body.len() - 16
                            && offset + length <= total
                        {
                            self.chunks.extend_from_slice(&body[16..]);
                            if self.chunks.len() == total {
                                if let Some(rows) = compressed_mixer(&self.chunks) {
                                    self.mixer = Some(rows);
                                }
                                self.chunks.clear();
                            }
                        }
                    }
                    _ => {}
                }
                consumed += size + 6;
            }
            self.buffer.drain(..consumed);
        }
        Some(())
    }
}

fn parameter(path: &str, value: f32) -> Vec<u8> {
    let mut body = path.as_bytes().to_vec();
    body.extend_from_slice(&[0, 0, 0]);
    body.extend_from_slice(&value.to_le_bytes());
    body
}

fn apply_parameter(rows: &mut [StudioOneChannel], body: &[u8]) {
    let Some(end) = body.iter().position(|&byte| byte == 0) else { return };
    if body.len() != end + 7 || body[end..end + 3] != [0, 0, 0] {
        return;
    }
    let Some((path, field)) = std::str::from_utf8(&body[..end])
        .ok().and_then(|key| key.strip_prefix("mixer/")).and_then(|key| key.rsplit_once('/'))
    else { return };
    let value = f32::from_le_bytes(body[end + 3..].try_into().unwrap()) as f64;
    if !(0.0..=1.0).contains(&value) {
        return;
    }
    let Some(row) = rows.iter_mut().find(|row| target(&row.token) == Some(path)) else { return };
    match field {
        "volume" if row.volume.is_some() => row.volume = Some(value),
        "mute" if row.mute.is_some() => row.mute = Some(value >= 0.5),
        "monitor" if row.monitor.is_some() => row.monitor = Some(value >= 0.5),
        "bypass" if row.plugin_enabled.is_some() => row.plugin_enabled = Some(value < 0.5),
        _ => {}
    }
}

fn target(token: &str) -> Option<&str> {
    token.strip_prefix("ucnet:")?.split_once('#').map(|(path, _)| path)
}

fn compressed_mixer(bytes: &[u8]) -> Option<Vec<StudioOneChannel>> {
    let mut json = Vec::new();
    ZlibDecoder::new(bytes)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut json)
        .ok()?;
    if json.len() > LIMIT {
        return None;
    }
    parse_mixer(&serde_json::from_slice(&json).ok()?)
}

fn parse_mixer(doc: &Value) -> Option<Vec<StudioOneChannel>> {
    if doc["id"] != "Synchronize" {
        return None;
    }
    let mixer = doc.pointer("/children/mixer/children")?.as_object()?;
    let mut rows = Vec::new();
    for bank in ["channel", "sub", "main"] {
        let Some(channels) = mixer
            .get(bank)
            .and_then(|value| value["children"].as_object())
        else {
            continue;
        };
        for (path, channel) in channels {
            let Some(label) = channel["values"]["label"]
                .as_str()
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let id = format!("ucnet:{bank}/{path}");
            let values = &channel["values"];
            let identity = values["identity"].as_str().unwrap_or(label);
            let volume = values["volume"].as_f64().filter(|value| (0.0..=1.0).contains(value));
            let switch = |field: &str| values[field].as_f64().map(|value| value >= 0.5);
            let index = path
                .strip_prefix("ch")
                .and_then(|n| n.parse::<i32>().ok())
                .map(|n| {
                    n + if bank == "channel" {
                        0
                    } else if bank == "sub" {
                        1000
                    } else {
                        2000
                    }
                });
            let row = StudioOneChannel {
                token: format!("{id}#{identity}"),
                id: Some(id.clone()),
                name: Some(label.into()),
                input: values["input"].as_str().map(str::trim)
                    .filter(|input| !input.is_empty()).map(str::to_owned),
                index,
                channel_type: None,
                volume,
                max_volume: volume.map(|_| 1.0),
                pan: None,
                mute: switch("mute"),
                solo: None,
                monitor: (values["type"] == "AudioTrack").then(|| switch("monitor")).flatten(),
                plugin: None,
                plugin_enabled: None,
            };
            rows.push(row.clone());
            if let Some(slots) = channel
                .pointer("/children/inserts/children")
                .and_then(Value::as_object)
            {
                let mut slots: Vec<_> = slots.iter().collect();
                slots.sort_by_key(|(slot, _)| {
                    slot.trim_start_matches("slot")
                        .parse::<u32>()
                        .unwrap_or(u32::MAX)
                });
                for (slot, device) in slots {
                    if let Some(name) = device["values"]["deviceName"]
                        .as_str()
                        .filter(|name| !name.is_empty())
                    {
                        rows.push(StudioOneChannel {
                            token: format!("{id}/inserts/{slot}#{identity}/{name}"),
                            plugin: Some(name.into()),
                            plugin_enabled: device["values"]["bypass"].as_f64().map(|value| value < 0.5),
                            volume: None,
                            max_volume: None,
                            mute: None,
                            monitor: None,
                            ..row.clone()
                        });
                    }
                }
            }
        }
    }
    Some(rows)
}

pub(super) fn snapshot(pid: u32, studio_pro: bool) -> Option<Vec<StudioOneChannel>> {
    let mut session = SESSION.lock().ok()?;
    if session.as_ref().is_some_and(|live| live.pid != pid) {
        *session = None;
    }
    if session.is_none() {
        let mut retry = RETRY.lock().ok()?;
        let route = match *retry {
            Some((last_pid, at, _)) if last_pid == pid && at.elapsed() < Duration::from_secs(4) => {
                return None;
            }
            Some((last_pid, _, previous)) if last_pid == pid => previous.other(),
            _ if studio_pro => Route::StudioPro,
            _ => Route::StudioOne,
        };
        *retry = Some((pid, Instant::now(), route));
        *session = Session::connect(pid, route);
    }
    let live = session.as_mut()?;
    if live.send(b"KA", &[]).is_err()
        || live.pump().is_none()
        || (live.mixer.is_none() && live.opened.elapsed() > Duration::from_secs(3))
    {
        *session = None;
        return None;
    }
    live.mixer.clone()
}

fn refresh_session(session: &mut Option<Session>) -> Result<&mut Session, String> {
    if session.as_mut().ok_or("Studio One 尚未连接")?.pump().is_none() {
        *session = None;
        return Err("Studio One 连接已断开".into());
    }
    session.as_mut().ok_or_else(|| "Studio One 尚未连接".into())
}

fn listening_on_same_input(rows: &[StudioOneChannel], target: &StudioOneChannel) -> Vec<String> {
    let Some(input) = target.input.as_deref() else { return Vec::new() };
    rows.iter()
        .filter(|row| row.token != target.token && row.monitor == Some(true) && row.input.as_deref() == Some(input))
        .map(|row| row.token.clone()).collect()
}

pub(super) fn set(pid: u32, token: &str, field: &str, value: f64) -> Result<(), String> {
    let mut session = SESSION.lock().map_err(|e| e.to_string())?;
    if !session.as_ref().is_some_and(|live| live.pid == pid) {
        return Err("Studio One 尚未连接".into());
    }
    let live = refresh_session(&mut session)?;
    let rows = live.mixer.as_deref().unwrap_or_default();
    let row = rows.iter().find(|row| row.token == token).ok_or("目标音轨或插件已变化，请重试")?;
    super::validate_write(row, field, value)?;
    let peers = if field == "monitor" && value == 1.0 {
        listening_on_same_input(rows, row)
    } else {
        Vec::new()
    };
    let mut closed = Vec::new();
    let mut enabling_target = false;
    let result = (|| {
        for peer in &peers {
            write_parameter(&mut session, peer, "monitor", 0.0)?;
            closed.push(peer);
        }
        enabling_target = !closed.is_empty();
        write_parameter(&mut session, token, field, value)
    })();
    if let Err(reason) = result {
        if !closed.is_empty() {
            // A timed-out enable may still have reached the host. Confirm off before
            // restoring the previous listeners; otherwise report the uncertain state.
            if enabling_target && write_parameter(&mut session, token, "monitor", 0.0).is_err() {
                return Err(format!("{reason}。未确认新通道的监听已关闭，请在 Studio One 检查。"));
            }
            let mut restored = true;
            for peer in closed.into_iter().rev() {
                restored &= write_parameter(&mut session, peer, "monitor", 1.0).is_ok();
            }
            if !restored {
                return Err(format!("{reason}。原通道未全部恢复，请在 Studio One 检查。"));
            }
        }
        return Err(reason);
    }
    Ok(())
}

fn write_parameter(session: &mut Option<Session>, token: &str, field: &str, value: f64) -> Result<(), String> {
    let live = refresh_session(session)?;
    let row = live.mixer.as_ref().and_then(|rows| rows.iter().find(|row| row.token == token))
        .ok_or("目标音轨或插件已变化，请重试")?;
    super::validate_write(row, field, value)?;
    let (field, value) = match field {
        "pluginEnabled" => ("bypass", 1.0 - value),
        "volume" | "mute" | "monitor" => (field, value),
        _ => return Err("不支持此 Studio One 控制项".into()),
    };
    let path = target(token).ok_or("Studio One 控制项无效")?;
    let matches_value = |row: &StudioOneChannel| match field {
        "volume" => row.volume.is_some_and(|actual| (actual - value).abs() < 0.0001),
        "bypass" => row.plugin_enabled == Some(value < 0.5),
        "mute" => row.mute == Some(value >= 0.5),
        "monitor" => row.monitor == Some(value >= 0.5),
        _ => false,
    };
    if matches_value(row) {
        return Ok(());
    }
    let body = parameter(&format!("mixer/{path}/{field}"), value as f32);
    if let Err(error) = live.send(b"PV", &body) {
        *session = None;
        return Err(format!("Studio One 控制指令未发送：{error}"));
    }
    let until = Instant::now() + CONTROL_CONFIRM_TIMEOUT;
    loop {
        if live.pump().is_none() {
            *session = None;
            return Err("Studio One 连接已断开".into());
        }
        let row = live.mixer.as_ref().and_then(|rows| rows.iter().find(|row| row.token == token))
            .ok_or("目标音轨或插件已变化，请重试")?;
        if matches_value(row) {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err("Studio One 未返回新的控制状态，请在宿主确认".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn connected(pid: u32) -> bool {
    SESSION.lock().is_ok_and(|live| {
        live.as_ref()
            .is_some_and(|connection| connection.pid == pid)
    })
}

pub(super) fn disconnect() {
    if let Ok(mut session) = SESSION.lock() {
        *session = None;
    }
    if let Ok(mut retry) = RETRY.lock() {
        *retry = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fader_accepts_a_host_confirmation_after_300_ms() {
        let path = "mixer/channel/ch2/volume";
        let update = parameter(path, 0.75);
        let write_frame = frame(b"PV", 104, 103, &update);
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut host, _) = listener.accept().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        socket.set_nonblocking(true).unwrap();
        let reply = std::thread::spawn(move || {
            let mut received = vec![0; write_frame.len()];
            host.read_exact(&mut received).unwrap();
            assert_eq!(received, write_frame);
            std::thread::sleep(Duration::from_millis(400));
            host.write_all(&frame(b"PV", 103, 104, &update)).unwrap();
            host
        });
        let doc = json!({"id":"Synchronize","children":{"mixer":{"children":{"channel":{"children":{
            "ch2":{"values":{"label":"Track 2","type":"AudioTrack","volume":0.76}}
        }}}}}});
        let mixer = parse_mixer(&doc).unwrap();
        let token = mixer[0].token.clone();
        let mut session = Some(Session {
            pid: 1,
            opened: Instant::now(),
            route: Route::StudioPro,
            socket,
            _udp: UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap(),
            buffer: Vec::new(),
            chunks: Vec::new(),
            mixer: Some(mixer),
        });

        let result = write_parameter(&mut session, &token, "volume", 0.75);
        let _host = reply.join().unwrap();
        assert_eq!(result, Ok(()), "a successful fader write must not be reported as failed");
        assert_eq!(session.unwrap().mixer.unwrap()[0].volume, Some(0.75));
    }

    #[test]
    fn mixer_snapshot_keeps_preloaded_slots_and_separates_same_named_tracks() {
        let doc = json!({"id":"Synchronize","children":{"mixer":{"children":{"channel":{"children":{
            "ch1":{"values":{"label":"主唱","type":"AudioTrack","volume":0.75,"mute":0,"monitor":0},"children":{"inserts":{"children":{
                "slot2":{"values":{"deviceName":"EQ","bypass":0}},"slot10":{"values":{"deviceName":"EQ","bypass":0}}
            }}}},
            "ch2":{"values":{"label":"主唱","volume":0.25,"mute":0}}
        }}}}}});
        let mut rows = parse_mixer(&doc).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(target(&rows[1].token), Some("channel/ch1/inserts/slot2"));
        assert_eq!(rows[1].id, rows[0].id);
        assert_ne!(rows[1].id, rows[3].id);
        assert_eq!(rows[0].volume, Some(0.75));
        assert_eq!(rows[0].monitor, Some(false));
        assert!(rows[3].monitor.is_none());
        apply_parameter(&mut rows, &parameter("mixer/channel/ch1/inserts/slot2/bypass", 1.0));
        apply_parameter(&mut rows, &parameter("mixer/channel/ch1/volume", 0.5));
        apply_parameter(&mut rows, &parameter("mixer/channel/ch1/mute", 1.0));
        apply_parameter(&mut rows, &parameter("mixer/channel/ch1/monitor", 1.0));
        assert_eq!(rows[1].plugin_enabled, Some(false));
        assert_eq!(rows[2].plugin_enabled, Some(true));
        assert_eq!(rows[0].volume, Some(0.5));
        assert_eq!(rows[0].mute, Some(true));
        assert_eq!(rows[0].monitor, Some(true));
        assert_eq!(rows[3].volume, Some(0.25));
        assert_eq!(rows[3].mute, Some(false));
    }

    #[test]
    fn parameter_body_matches_host_shape() {
        assert_eq!(
            parameter("recorddiskspace/remainingPercent", f32::from_le_bytes([0x17, 0x2b, 0xa9, 0x3c])),
            b"recorddiskspace/remainingPercent\0\0\0\x17\x2b\xa9\x3c"
        );
    }

    #[test]
    fn enabling_monitor_only_closes_other_tracks_using_the_same_reported_input() {
        let audio = |label: &str, input: &str, monitor: u8| json!({
            "values": {"label": label, "type": "AudioTrack", "input": input, "monitor": monitor}
        });
        let doc = json!({"id":"Synchronize","children":{"mixer":{"children":{"channel":{"children":{
            "ch1": audio("主唱", "Input L", 0),
            "ch2": audio("和声", "Input L", 1),
            "ch3": audio("主唱", "Input R", 1),
            "ch4": audio("乐器", "", 1),
            "ch5": audio("未设置", "", 1),
            "ch6": audio("录音", "Input L", 0)
        }}}}}});
        let rows = parse_mixer(&doc).unwrap();
        let track = |path| rows.iter().find(|row| target(&row.token) == Some(path)).unwrap();
        assert_eq!(listening_on_same_input(&rows, track("channel/ch1")), vec![track("channel/ch2").token.clone()]);
        assert!(listening_on_same_input(&rows, track("channel/ch4")).is_empty());
    }
}
