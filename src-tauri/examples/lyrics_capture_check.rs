#[allow(dead_code)]
#[path = "../src/lyrics_capture.rs"]
mod lyrics_capture;
#[allow(dead_code)]
#[path = "../src/lyrics_capture_d3d.rs"]
mod lyrics_capture_d3d;

fn main() {
    use std::io::{Read, Write};
    let html = r#"<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}div{position:absolute;left:90px;top:100px;color:#fff;font:64px sans-serif;text-shadow:0 0 24px #e040e0;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(260px)}}span{color:rgba(50,220,100,.45)}i{position:absolute;top:20px;width:40px;height:40px}#opaque{left:20px;background:#fff}#translucent{left:80px;background:rgba(50,220,100,.45)}#glow{left:140px;background:rgba(224,64,224,.35);box-shadow:0 0 18px rgba(224,64,224,.35)}</style><i id="opaque"></i><i id="translucent"></i><i id="glow"></i><div>透明歌词 <span>Folia glow</span></div>"#;
    let html = if std::env::var_os("RUSTMUSIC_CAPTURE_STATIC_FIXTURE").is_some() { html.replace("animation:move 1s linear infinite alternate", "animation:none") } else { html.to_owned() };
    let geometry = std::env::args().nth(1).and_then(|value| serde_json::from_str(&value).ok()).unwrap_or(serde_json::Value::Null);
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", server.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in server.incoming().flatten() {
            let _ = stream.read(&mut [0; 4096]);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
        }
    });
    lyrics_capture::run_source(url, "透明歌词游戏采集验证".to_owned(), geometry);
}
