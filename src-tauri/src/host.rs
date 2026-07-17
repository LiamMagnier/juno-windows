use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub device_name: String,
    pub platform: String,
    pub arch: String,
    pub app_version: String,
}

#[tauri::command]
pub fn host_info(app: tauri::AppHandle) -> HostInfo {
    let device_name = hostname();
    HostInfo {
        device_name,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

fn hostname() -> String {
    #[cfg(windows)]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            if !name.is_empty() {
                return name;
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(output) = std::process::Command::new("hostname").output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "Windows PC".to_string()
}
