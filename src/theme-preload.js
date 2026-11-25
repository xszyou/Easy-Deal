// 0.3.54: 在 renderer.js 之前跑一次，把 data-theme / data-font-size 立刻打到
// documentElement 上，避免浅色用户看到深色闪一下再切（FOUC）。
// 纯渲染层偏好，localStorage 存 ezdl.theme + ezdl.fontSize。
(function () {
  try {
    var theme = localStorage.getItem('ezdl.theme') || 'dark';
    var fontSize = localStorage.getItem('ezdl.fontSize') || 'md';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-font-size', fontSize);
  } catch (e) {}
  // expose 全局 helper 给 settings UI 修改后立刻应用
  window.applyAppearance = function () {
    try {
      var theme = localStorage.getItem('ezdl.theme') || 'dark';
      var fontSize = localStorage.getItem('ezdl.fontSize') || 'md';
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.setAttribute('data-font-size', fontSize);
    } catch (e) {}
  };
})();
