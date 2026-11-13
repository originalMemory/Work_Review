/**
 * 把弹层节点移挂到 document.body。
 *
 * 祖先带 backdrop-filter / filter / transform 时，position: fixed 的包含块
 * 会被劫持为该祖先（坐标系与视口脱钩、层叠上下文被局部化），导致按视口
 * 坐标定位的浮层整体错位、底部超出窗口被裁。移到 body 之后 fixed 恢复
 * 以视口为包含块，z-index 也回到全局层叠上下文参与比较。
 */
export function portalToBody(node: HTMLElement): { destroy: () => void } {
  if (node.parentElement !== document.body) {
    document.body.appendChild(node);
  }

  return {
    destroy() {
      node.parentElement?.removeChild(node);
    },
  };
}
