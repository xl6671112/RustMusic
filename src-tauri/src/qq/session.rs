//! Persist the complete login response needed for normal account session renewal.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::url::{credential_cookie, find_credential};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct QqSession {
    pub musicid: String,
    pub musickey: String,
    pub login_type: u64,
    pub openid: String,
    pub access_token: String,
    pub refresh_token: String,
    pub refresh_key: String,
    pub unionid: String,
    pub expired_at: u64,
    pub key_created_at: u64,
    pub key_expires_in: u64,
}

impl std::fmt::Debug for QqSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QqSession")
            .field("login_type", &self.login_type)
            .finish_non_exhaustive()
    }
}

/// FnOnce renewal bounds recovery to one attempt even if the retried request is denied.
pub fn with_session_retry<T>(
    session: &QqSession,
    renewal_attempted: bool,
    request: impl Fn(&QqSession) -> Result<T, super::QqUrlError>,
    renew: impl FnOnce(super::QqUrlError) -> Result<QqSession, String>,
) -> Result<T, String> {
    match request(session) {
        Err(error) if error.needs_refresh() && !renewal_attempted => {
            let next = renew(error)?;
            request(&next).map_err(|e| e.to_string())
        }
        result => result.map_err(|e| e.to_string()),
    }
}

fn number(v: &Value, key: &str) -> u64 {
    v.get(key)
        .and_then(|n| n.as_u64().or_else(|| n.as_str()?.parse().ok()))
        .unwrap_or(0)
}

impl QqSession {
    pub fn legacy(musicid: String, musickey: String) -> Self {
        let login_type = if musickey.starts_with("W_X") { 1 } else { 2 };
        Self {
            musicid,
            musickey,
            login_type,
            ..Self::default()
        }
    }

    pub fn from_response(v: &Value) -> Option<Self> {
        if v.get("musickey").is_some() {
            let (musicid, musickey) = find_credential(v)?;
            let mut session = Self::legacy(musicid, musickey);
            let text = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
            session.openid = text("openid");
            session.access_token = text("access_token");
            session.refresh_token = text("refresh_token");
            session.refresh_key = text("refresh_key");
            session.unionid = text("unionid");
            session.expired_at = number(v, "expired_at");
            session.key_created_at = number(v, "musickeyCreateTime");
            session.key_expires_in = number(v, "keyExpiresIn");
            if v.get("loginType").is_some() {
                session.login_type = number(v, "loginType");
            }
            return Some(session);
        }
        match v {
            Value::Object(obj) => obj.values().find_map(Self::from_response),
            Value::Array(items) => items.iter().find_map(Self::from_response),
            _ => None,
        }
    }

    pub fn can_refresh(&self) -> bool {
        !self.musicid.is_empty()
            && !self.musickey.is_empty()
            && (!self.refresh_key.is_empty() || !self.refresh_token.is_empty())
    }

    pub fn refresh_due(&self, now: u64) -> bool {
        self.can_refresh()
            && self.key_created_at > 0
            && self.key_expires_in > 0
            && now.saturating_add(300) >= self.key_created_at.saturating_add(self.key_expires_in)
    }

    fn refresh_payload(&self) -> Value {
        let mut param = json!({
            "openid": self.openid,
            "refresh_token": self.refresh_token,
            "musickey": self.musickey,
            "refresh_key": self.refresh_key,
            "loginMode": 2,
        });
        if self.login_type == 1 {
            param["str_musicid"] = json!(self.musicid);
            param["unionid"] = json!(self.unionid);
        } else {
            param["musicid"] = json!(self.musicid.parse::<u64>().unwrap_or(0));
            param["access_token"] = json!(self.access_token);
            param["expired_in"] = json!(self.expired_at);
        }
        json!({
            "comm": {
                "ct": 24, "cv": 0, "platform": "yqq", "tmeAppID": "qqmusic",
                "tmeLoginType": self.login_type, "uin": self.musicid,
                "authst": self.musickey, "g_tk": super::hash33(&self.musickey, 5381),
            },
            "req_1": {"module": "music.login.LoginServer", "method": "Login", "param": param}
        })
    }

    pub fn refresh(&self) -> Result<Self, String> {
        let cookie = credential_cookie(&self.musicid, &self.musickey);
        let response = super::musicu_signed(&self.refresh_payload(), Some(&cookie))?;
        self.refreshed_from(&response)
    }

    fn refreshed_from(&self, response: &Value) -> Result<Self, String> {
        let valid = response.get("code").and_then(Value::as_i64).unwrap_or(0) == 0
            && response.pointer("/req_1/code").and_then(Value::as_i64) == Some(0);
        let mut next = Self::from_response(response)
            .filter(|next| valid && next.musicid == self.musicid)
            .ok_or_else(|| {
                crate::i18n::pick(
                    "QQ 音乐登录续期失败，请重新扫码登录",
                    "QQ Music session renewal failed. Please sign in again.",
                )
                .to_string()
            })?;
        // Some successful renewals omit unchanged fields; keep the account's refresh chain.
        for (new, old) in [
            (&mut next.openid, &self.openid),
            (&mut next.access_token, &self.access_token),
            (&mut next.refresh_token, &self.refresh_token),
            (&mut next.refresh_key, &self.refresh_key),
            (&mut next.unionid, &self.unionid),
        ] {
            if new.is_empty() {
                *new = old.clone();
            }
        }
        next.login_type = self.login_type;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> QqSession {
        QqSession::from_response(&json!({"req_1":{"code":0,"data":{
            "musicid":123, "musickey":"old", "refresh_key":"rk", "refresh_token":"rt",
            "openid":"oid", "access_token":"at", "loginType":2,
            "musickeyCreateTime":1000,"keyExpiresIn":86400
        }}}))
        .unwrap()
    }

    #[test]
    fn persisted_session_retains_renewal_fields_after_restart() {
        let original = session();
        let restored: QqSession =
            serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        let payload = restored.refresh_payload();
        assert_eq!(
            payload.pointer("/req_1/param/refresh_key"),
            Some(&json!("rk"))
        );
        assert_eq!(
            payload.pointer("/req_1/param/access_token"),
            Some(&json!("at"))
        );
        assert!(!restored.refresh_due(2000));
        assert!(restored.refresh_due(87400));
    }

    #[test]
    fn wechat_renewal_uses_string_id_and_its_own_login_type() {
        let mut session = session();
        session.login_type = 1;
        let payload = session.refresh_payload();
        assert_eq!(
            payload.pointer("/req_1/param/str_musicid"),
            Some(&json!("123"))
        );
        assert_eq!(payload.pointer("/comm/tmeLoginType"), Some(&json!(1)));
    }

    #[test]
    fn renewal_preserves_omitted_tokens_and_accepts_rotated_tokens() {
        let session = session();
        let next = session
            .refreshed_from(&json!({"req_1":{"code":0,"data":{
                "musicid":123,"musickey":"new","refresh_key":"rotated"
            }}}))
            .unwrap();
        assert_eq!(next.musickey, "new");
        assert_eq!(next.refresh_key, "rotated");
        assert_eq!(next.refresh_token, "rt");
    }

    #[test]
    fn invalid_or_different_account_response_cannot_replace_login() {
        let session = session();
        for response in [
            json!({"req_1":{"code":104401,"data":{"musicid":123,"musickey":"bad"}}}),
            json!({"req_1":{"code":0,"data":{"musicid":456,"musickey":"other"}}}),
            json!({"req_1":{"code":0,"data":{}}}),
        ] {
            assert!(session.refreshed_from(&response).is_err());
        }
        assert_eq!(session.musickey, "old");
    }

    #[test]
    fn legacy_login_without_refresh_material_does_not_claim_renewal_support() {
        assert!(!QqSession::legacy("123".into(), "old".into()).can_refresh());
    }

    #[test]
    fn expired_key_is_renewed_once_then_original_request_is_retried() {
        let session = session();
        let attempts = std::cell::Cell::new(0);
        let result = with_session_retry(
            &session,
            false,
            |s| {
                attempts.set(attempts.get() + 1);
                if s.musickey == "old" {
                    Err(super::super::QqUrlError::SessionExpired)
                } else {
                    Ok("authorized url")
                }
            },
            |_| {
                let mut next = session.clone();
                next.musickey = "new".into();
                Ok(next)
            },
        );
        assert_eq!(result.unwrap(), "authorized url");
        assert_eq!(attempts.get(), 2);
    }

    #[test]
    fn membership_denial_after_renewal_cannot_loop() {
        let session = session();
        let renewals = std::cell::Cell::new(0);
        let result: Result<(), _> = with_session_retry(
            &session,
            false,
            |_| Err(super::super::QqUrlError::Entitlement),
            |_| {
                renewals.set(renewals.get() + 1);
                Ok(session.clone())
            },
        );
        assert!(result.is_err());
        assert_eq!(renewals.get(), 1);
    }

    #[test]
    fn transport_failure_or_prior_renewal_does_not_trigger_repeated_renewal() {
        let session = session();
        for already_renewed in [false, true] {
            let result: Result<(), _> = with_session_retry(
                &session,
                already_renewed,
                |_| Err(super::super::QqUrlError::Other("network failure".into())),
                |_| panic!("network errors must not renew login"),
            );
            assert!(result.is_err());
        }
        let result: Result<(), _> = with_session_retry(
            &session,
            true,
            |_| Err(super::super::QqUrlError::SessionExpired),
            |_| panic!("only one renewal is allowed"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn failed_renewal_does_not_retry_with_or_replace_invalid_credentials() {
        let session = session();
        let requests = std::cell::Cell::new(0);
        let result: Result<(), _> = with_session_retry(
            &session,
            false,
            |_| {
                requests.set(requests.get() + 1);
                Err(super::super::QqUrlError::SessionExpired)
            },
            |_| Err("renewal network failure".into()),
        );
        assert_eq!(result.unwrap_err(), "renewal network failure");
        assert_eq!(requests.get(), 1);
        assert_eq!(session.musickey, "old");
    }
}
