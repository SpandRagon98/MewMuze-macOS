export interface ClipboardReactionContext {
  hidden: boolean;
  paused: boolean;
  fullscreen: boolean;
  dragging: boolean;
  grounded: boolean;
  activeNotice: boolean;
  quickTools: boolean;
}

export function canPlayClipboardReaction(context: ClipboardReactionContext): boolean {
  return (
    !context.hidden &&
    !context.paused &&
    !context.fullscreen &&
    !context.dragging &&
    context.grounded &&
    !context.activeNotice &&
    !context.quickTools
  );
}
