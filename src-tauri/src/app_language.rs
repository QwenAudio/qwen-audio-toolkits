use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
pub(crate) enum UiLanguage {
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

#[cfg(target_os = "macos")]
impl UiLanguage {
    fn text<'a>(self, chinese: &'a str, english: &'a str) -> &'a str {
        match self {
            Self::Chinese => chinese,
            Self::English => english,
        }
    }
}

#[tauri::command]
pub(crate) fn set_ui_language(app: tauri::AppHandle, language: UiLanguage) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    set_menu(&app, language).map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, language);
    Ok(())
}

/// Keep native menu actions and shortcuts; only the displayed labels change.
#[cfg(target_os = "macos")]
pub(crate) fn set_menu(app: &tauri::AppHandle, language: UiLanguage) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Item, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };
    let text = |zh, en| language.text(zh, en);
    let name = &app.package_info().name;
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let application_menu = Submenu::with_items(
        app,
        name,
        true,
        &[
            &Item::about(
                app,
                Some(&format!("{} {name}", text("关于", "About"))),
                Some(about),
            )?,
            &Item::separator(app)?,
            &MenuItem::with_id(
                app,
                "check-update",
                text("检查更新…", "Check for Updates…"),
                true,
                None::<&str>,
            )?,
            &Item::separator(app)?,
            &Item::services(app, Some(text("服务", "Services")))?,
            &Item::separator(app)?,
            &Item::hide(app, Some(&format!("{} {name}", text("隐藏", "Hide"))))?,
            &Item::hide_others(app, Some(text("隐藏其他", "Hide Others")))?,
            &Item::separator(app)?,
            &Item::quit(app, Some(&format!("{} {name}", text("退出", "Quit"))))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        text("文件", "File"),
        true,
        &[&Item::close_window(
            app,
            Some(text("关闭窗口", "Close Window")),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        text("编辑", "Edit"),
        true,
        &[
            &Item::undo(app, Some(text("撤销", "Undo")))?,
            &Item::redo(app, Some(text("重做", "Redo")))?,
            &Item::separator(app)?,
            &Item::cut(app, Some(text("剪切", "Cut")))?,
            &Item::copy(app, Some(text("拷贝", "Copy")))?,
            &Item::paste(app, Some(text("粘贴", "Paste")))?,
            &Item::select_all(app, Some(text("全选", "Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        text("显示", "View"),
        true,
        &[&Item::fullscreen(
            app,
            Some(text("切换全屏", "Toggle Full Screen")),
        )?],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        text("窗口", "Window"),
        true,
        &[
            &Item::minimize(app, Some(text("最小化", "Minimize")))?,
            &Item::maximize(app, Some(text("缩放", "Zoom")))?,
            &Item::separator(app)?,
            &Item::close_window(app, Some(text("关闭窗口", "Close Window")))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, text("帮助", "Help"), true, &[])?;
    app.set_menu(Menu::with_items(
        app,
        &[&application_menu, &file, &edit, &view, &window, &help],
    )?)?;
    Ok(())
}
