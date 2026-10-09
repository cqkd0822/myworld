/**
 * 站点配置 —— 要改的东西基本都在这个文件里。
 *
 * ⚠️ mapKey 是**前端 key**，写在这里意味着任何人打开网页都能看到它。
 *    这是腾讯地图前端 key 的固有性质，不是配置失误。防护手段是在
 *    腾讯位置服务控制台给这个 key **配置域名白名单**，只允许你自己的域名调用。
 *    另外建议在控制台把它设为「仅 JavaScript API GL」+ 限制配额。
 */

window.MYWORLD = window.MYWORLD || {};

window.MYWORLD.site = {
  title: 'MyWorld',
  tagline: '飞行 · 铁路 · 足迹',

  /** 腾讯位置服务 key（前端可见，务必配域名白名单） */
  mapKey: 'EHMBZ-JUT6M-IJP6Y-6URXU-7S6TQ-GZBX4',

  /**
   * 底图样式（航迹图用）。留空 = 官方默认浅色底图。
   *
   * 想要航旅纵横那种深色底图，需要先在腾讯位置服务控制台把一个
   * 深色样式绑定到上面这个 key（免费）：
   *   控制台 → 应用与样式 → 个性化样式 → 挑一个深色模板（墨渊/黑色极简/微信深色）
   *   → 绑定到这个 key，然后把它对应的 style 编号填在这里，例如：
   * mapStyleId: 'style1',   // 墨渊（深色）
   *
   * ⚠️ 不要填一个没绑定到这个 key 的编号——底图会整片返灰，这是实测结论。
   */
  mapStyleId: '',

  /** 仓库地址，页脚会链过去 */
  repo: 'https://github.com/cqkd0822/myworld',
};
