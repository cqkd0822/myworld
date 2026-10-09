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
   * 'style1' = 控制台已绑定到 key 的个性化样式（当前为「微信深色」模板）。
   * 实测结论：绑定后仅 style1 有效，style2–style8 均报「并未找到」并回退默认样式。
   * 若在控制台换绑其他样式，保持 'style1' 即可（样式内容跟随控制台配置）。
   */
  mapStyleId: 'style1',

  /** 仓库地址，页脚会链过去 */
  repo: 'https://github.com/cqkd0822/myworld',
};
