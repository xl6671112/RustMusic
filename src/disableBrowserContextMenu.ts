// 仅关闭 WebView 默认菜单，事件仍交给歌曲等自定义右键菜单处理。
document.addEventListener("contextmenu", (event) => event.preventDefault(), true);
