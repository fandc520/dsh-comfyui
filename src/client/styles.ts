/**
 * dsh-comfyui stylesheet, injected once with plugin ownership. Colors come
 * from the host theme tokens (--dsw-alias-*), so the UI follows light/dark.
 */
const CSS = `
/* --- shared primitives --- */
.dsc-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsc-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.dsc-badge {
  border-radius: 999px; padding: 1px 8px; font-size: 11px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
}
.dsc-badge--ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.dsc-badge--err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.dsc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin-top: 6px; }
.dsc-media { border-radius: 6px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsc-media img, .dsc-media video, .dsc-media audio { display: block; width: 100%; max-height: 320px; object-fit: contain; background: #000; }
.dsc-media audio { height: 44px; }
.dsc-media-img--clickable { cursor: zoom-in; }
.dsc-media-other { display: block; padding: 8px 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dsc-media-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 6px; }
.dsc-media-size { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsc-media-meta a { display: inline; padding: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); text-decoration: none; }
.dsc-media-meta a:hover { color: var(--dsw-alias-label-primary); }
.dsc-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsc-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 4px 0; }
.dsc-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; margin: 4px 0; }
.dsc-form { display: flex; flex-direction: column; gap: 12px; max-width: 460px; }
.dsc-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--dsw-alias-label-primary); }
.dsc-input, .dsc-textarea {
  width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: inherit; font-size: 13px;
}
select.dsc-input { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); color-scheme: inherit; }
select.dsc-input option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsc-textarea { min-height: 90px; resize: vertical; font-family: ui-monospace, monospace; }
.dsc-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.dsc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsc-btn {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: transparent; color: inherit; padding: 5px 12px; font-size: 13px; cursor: pointer;
}
.dsc-btn:disabled { opacity: 0.5; cursor: default; }
.dsc-btn--link { display: inline-block; text-decoration: none; }
/* --- header action trigger --- */
.dsc-trigger {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 13px; padding: 3px 8px; border-radius: 6px;
  white-space: nowrap;
}
.dsc-trigger:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.dsc-trigger[aria-pressed='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsc-trigger-glyph { font-size: 13px; line-height: 1; }
/* --- panel shell: floating window, percentage-anchored to the page header
   (top) and the composer (bottom), draggable by the header and resizable via
   the corner handle. Follows the host light/dark theme. --- */
.dsc-panel {
  position: fixed;
  top: var(--dsc-panel-top, 9%);
  right: var(--dsc-panel-right, 1.5%);
  bottom: var(--dsc-panel-bottom, 2%);
  width: var(--dsc-panel-width, 400px);
  max-width: min(92vw, 560px); min-width: 300px;
  z-index: 900;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  user-select: none;
}
.dsc-panel--dragging { cursor: grabbing; }
.dsc-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: grab; touch-action: none; }
.dsc-panel--dragging .dsc-panel-head { cursor: grabbing; }
.dsc-panel-resize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; touch-action: none;
  background: linear-gradient(135deg, transparent 50%, var(--dsw-alias-label-tertiary) 50%);
  border-bottom-right-radius: 14px;
  opacity: 0.55;
}
.dsc-panel-resize:hover { opacity: 1; }
.dsc-panel-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.dsc-panel-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; padding: 4px 8px; }
.dsc-panel-close:hover { color: var(--dsw-alias-label-primary); }
.dsc-tabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsc-tab {
  flex: 1; padding: 8px 4px; background: transparent; border: none;
  border-bottom: 2px solid transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; font-size: 13px;
}
.dsc-tab--active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.dsc-panel-body { flex: 1; overflow-y: auto; padding: 10px 12px; }
.dsc-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.dsc-list { display: flex; flex-direction: column; gap: 8px; }
/* --- workflows tab --- */
.dsc-wf { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); transition: background 0.12s, border-color 0.12s; cursor: pointer; }
.dsc-wf:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-wf-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-wf--comfyui { display: flex; align-items: center; gap: 10px; }
.dsc-wf-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.dsc-wf-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-wf-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsc-wf-updated { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-top: 4px; }
.dsc-wf-actions { display: flex; gap: 6px; margin-top: 6px; }
.dsc-section { margin-top: 14px; }
.dsc-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.dsc-section-title { font-weight: 600; font-size: 13px; }
.dsc-fold { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; margin-top: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.dsc-fold summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer; user-select: none; font-weight: 600; font-size: 13px; }
.dsc-fold summary::-webkit-details-marker { display: none; }
.dsc-fold summary::before { content: '▸'; font-size: 11px; color: var(--dsw-alias-label-secondary); transition: transform 0.15s; }
.dsc-fold[open] summary::before { transform: rotate(90deg); }
.dsc-fold summary:hover { background: var(--dsw-alias-bg-layer-2); }
.dsc-fold-body { padding: 0 10px 10px; }
.dsc-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; margin: 2px 0 6px; white-space: pre-line; }
.dsc-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.dsc-badge--ok { color: var(--dsw-alias-state-success-primary); border: 1px solid var(--dsw-alias-state-success-primary); }
.dsc-badge--warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.dsc-view-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dsc-view-label { font-weight: 600; font-size: 12px; margin: 8px 0 4px; }
.dsc-node-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); max-height: 180px; overflow-y: auto; }
.dsc-node-list li { margin: 2px 0; }
.dsc-textarea--view { min-height: 220px; resize: vertical; }
.dsc-derived { margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.dsc-derived-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.dsc-derived-name { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-dialog { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px; }
.dsc-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.dsc-extract-modes { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
.dsc-mode { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.dsc-mode input { accent-color: var(--dsw-alias-brand-primary); }
.dsc-mode-label { font-size: 13px; }
/* --- assets tab --- */
.dsc-assets-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.dsc-asset { position: relative; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-layer-1); }
/* Destructive, so it only appears while the pointer is on the card. */
.dsc-asset-trash {
  position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary);
  font-size: 14px; cursor: pointer; opacity: 0; transition: opacity 0.12s;
}
.dsc-asset:hover .dsc-asset-trash, .dsc-asset-trash:focus-visible { opacity: 1; }
.dsc-asset-trash:hover { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-asset img, .dsc-asset video { width: 100%; height: 110px; object-fit: cover; display: block; background: #000; }
.dsc-asset-audio-icon { position: relative; width: 100%; height: 110px; box-sizing: border-box; padding: 0 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #26702b; overflow: hidden; }
.dsc-asset-audio-icon-wave { position: absolute; inset: 0; width: 100%; height: 100%; }
.dsc-asset-audio-icon-sym { position: relative; width: 42px; height: 42px; color: #fff; }
.dsc-asset-audio-icon-name { position: relative; max-width: 100%; font-size: 11px; color: rgba(255, 255, 255, 0.9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsc-asset--empty {
  height: 110px; padding: 8px; box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center;
}
.dsc-asset-meta { padding: 3px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* confirmation modal (asset deletion) */
.dsc-confirm { width: min(360px, 88vw); display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32); }
.dsc-confirm-title { font-weight: 600; font-size: 14px; }
.dsc-confirm-body { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsc-confirm-detail { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); word-break: break-all; max-height: 96px; overflow-y: auto; }
.dsc-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
.dsc-btn--danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsc-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-asset-detail-media { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.dsc-asset-detail-media img, .dsc-asset-detail-media video { width: 100%; max-height: 320px; object-fit: contain; background: #000; border-radius: 8px; }
.dsc-asset-detail-file { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; }
.dsc-input--inline { width: auto; }
/* --- queue tab --- */
.dsc-queue-head { display: flex; gap: 8px; flex-wrap: wrap; }
.dsc-queue-item { display: flex; gap: 8px; align-items: center; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; font-size: 12px; flex-wrap: wrap; }
.dsc-queue-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.dsc-queue-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsc-queue-tracked { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.dsc-progress { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 90px; }
.dsc-progress-track { flex: 1; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsc-progress-fill { height: 100%; background: #3b82f6; transition: width 0.4s; }
.dsc-progress:hover .dsc-progress-fill { background: #2563eb; }
.dsc-param-upload-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.dsc-param-upload-wrap select { flex: 1; min-width: 0; }
.dsc-dropzone { flex: 1; min-width: 120px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 6px; padding: 5px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; cursor: pointer; transition: border-color 0.12s, color 0.12s; }
.dsc-dropzone:hover, .dsc-dropzone--over { border-color: #3b82f6; color: #3b82f6; }
.dsc-upload-select { position: relative; flex: 1; min-width: 0; }
.dsc-upload-select-btn { display: flex; align-items: center; gap: 6px; width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; text-align: left; }
.dsc-upload-select-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dsc-upload-select-thumb { width: 36px; height: 24px; object-fit: cover; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); flex: none; }
.dsc-upload-select-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsc-upload-select-pop { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; max-height: 220px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); padding: 4px; }
.dsc-upload-select-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-select-item:hover { background: var(--dsw-alias-bg-layer-3); }
.dsc-upload-dock { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.dsc-upload-dock-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-upload-dock-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-dock-zone { min-height: 44px; display: flex; align-items: center; justify-content: center; }
.dsc-upload-list { display: flex; flex-direction: column; gap: 4px; }
.dsc-upload-item { display: flex; align-items: center; gap: 8px; }
.dsc-upload-thumb { width: 40px; height: 28px; object-fit: cover; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); flex: none; }
.dsc-upload-thumb--media { display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
.dsc-upload-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-upload-select-item--active { background: var(--dsw-alias-bg-layer-3); }
/* --- load area: big preview + picker dialog (ComfyUI LoadImage-like) --- */
.dsc-loadarea { margin-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.dsc-loadarea-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsc-loadarea-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary); }
/* load-area slots: slot 0 is the primary (big) source, the rest are thumbs.
   Each slot carries its own actions (add / clear media / delete slot). */
.dsc-loadslots { display: flex; flex-wrap: wrap; gap: 8px; }
/* One slot stretches across the panel; from two on they share a fixed width
   and wrap into rows. The × sits in the corner and appears on hover. */
.dsc-loadslot { position: relative; display: flex; flex-direction: column; gap: 4px; width: 128px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 6px; background: var(--dsw-alias-bg-layer-1); }
.dsc-loadslot--wide { width: 100%; }
.dsc-loadslot-pick { display: flex; flex-direction: column; align-items: center; gap: 4px; border: none; border-radius: 8px; padding: 0; background: transparent; color: inherit; cursor: pointer; width: 100%; }
.dsc-loadslot-media { width: 100%; height: 104px; object-fit: contain; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsc-loadslot--wide .dsc-loadslot-media { height: 220px; }
.dsc-loadslot-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; width: 100%; height: 104px; border-radius: 6px; border: 1px dashed var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.dsc-loadslot--wide .dsc-loadslot-empty { height: 120px; font-size: 13px; }
.dsc-loadslot-name { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dsw-alias-label-primary); text-align: center; }
.dsc-loadslot-index { color: var(--dsw-alias-label-tertiary); }
.dsc-loadslot-add { color: var(--dsw-alias-label-secondary); }
.dsc-loadslot-pick:hover .dsc-loadslot-add { color: var(--dsw-alias-brand-primary); }
.dsc-loadslot-x {
  position: absolute; top: 3px; right: 3px; width: 26px; height: 26px; padding: 0; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font-size: 18px; cursor: pointer; opacity: 0; transition: opacity 0.12s;
}
.dsc-loadslot:hover .dsc-loadslot-x, .dsc-loadslot-x:focus-visible { opacity: 1; }
.dsc-loadslot-x:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsc-picker-player { width: 100%; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
video.dsc-picker-player { max-height: 180px; }
.dsc-picker-player--audio { height: 34px; }
.dsc-loadslot-x:disabled { opacity: 0; cursor: default; }
.dsc-picker-card--none .dsc-picker-thumb--media { font-size: 26px; color: var(--dsw-alias-label-tertiary); }
/* picker overlay: dims the page, dialog floats in the center */
.dsc-picker-overlay { position: fixed; inset: 0; z-index: 9990; background: rgba(6, 8, 12, 0.6); display: flex; align-items: center; justify-content: center; padding: 24px; }
.dsc-picker { position: relative; display: flex; flex-direction: column; width: min(860px, 92vw); height: min(560px, 84vh); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: 0 16px 56px rgba(0, 0, 0, 0.5); overflow: hidden; }
.dsc-picker-toast { position: absolute; top: 54px; left: 50%; transform: translateX(-50%); z-index: 5; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); padding: 6px 14px; border-radius: 8px; font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); pointer-events: none; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-picker-bar { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsc-picker-tab { border: 1px solid transparent; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-picker-tab--active { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-picker-tabs { display: flex; gap: 4px; }
.dsc-picker-type { flex: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 3px 8px; font-size: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dsc-picker-upload { margin: 0 auto; flex: none; max-width: 200px; min-height: 32px; display: flex; align-items: center; justify-content: center; padding: 0 12px; font-size: 12px; white-space: nowrap; }
.dsc-picker-empty { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsc-picker-grid { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px; display: flex; gap: 10px; align-items: flex-start; }
.dsc-picker-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.dsc-picker-card { display: flex; flex-direction: column; gap: 4px; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; text-align: left; }
.dsc-picker-card:hover { border-color: #3b82f6; }
.dsc-picker-card--active { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsc-picker-thumb { width: 100%; height: auto; object-fit: contain; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
.dsc-picker-thumb--media { display: flex; align-items: center; justify-content: center; height: 100px; font-size: 22px; }
.dsc-picker-name { font-size: 13px; line-height: 1.5; padding: 2px 0; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-picker-card:hover .dsc-picker-name { color: var(--dsw-alias-brand-primary); }
/* --- workflow tags: filter bar, chips, editor --- */
.dsc-tag-filter { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0 2px; }
.dsc-tag-chip { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-tag-chip--active { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-tag-chip--mini { font-size: 11px; padding: 1px 8px; cursor: default; border: 1px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dsc-wf-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.dsc-wf-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; }
.dsc-wf-top .dsc-wf-tags { margin-top: 0; flex: none; justify-content: flex-end; }
.dsc-tag-editor { display: flex; flex-direction: column; gap: 6px; }
.dsc-tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
.dsc-tag-input { max-width: 260px; }
.dsc-chip { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-chip--active { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-badge--info { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-layer-1); }
.dsc-badge--danger { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsc-queue-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsc-btn { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); }
.dsc-btn--sm { padding: 1px 6px; font-size: 11px; }
.dsc-btn:disabled { opacity: 0.5; cursor: default; }
.dsc-job-item { display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; background: var(--dsw-alias-bg-layer-1); transition: background 0.12s, border-color 0.12s; }
.dsc-job-item:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dsc-job-item--failed { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.dsc-job-item--cancelled { border-color: var(--dsw-alias-border-l2); opacity: 0.85; }
.dsc-badge--status { flex: none; font-weight: 600; }
.dsc-job-preview { width: 56px; height: 56px; flex: none; border-radius: 6px; object-fit: cover; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsc-job-preview--clickable { cursor: zoom-in; }
/* --- lightbox: floating local panel, no full-screen dim --- */
.dsc-lightbox { position: fixed; inset: 0; z-index: 9999; background: transparent; display: flex; align-items: center; justify-content: center; }
.dsc-lightbox-body { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; width: 90vw; padding: 12px 12px 10px; background: rgba(12, 14, 18, 0.88); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45); }
.dsc-lightbox-img { width: 100%; height: 80vh; object-fit: contain; border-radius: 8px; }
.dsc-lightbox-media { max-width: 100%; max-height: 80vh; border-radius: 8px; }
.dsc-lightbox-meta { display: flex; align-items: center; gap: 14px; color: rgba(255, 255, 255, 0.75); font-size: 12px; }
.dsc-lightbox-download { border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 999px; padding: 5px 16px; color: #fff; font-size: 12px; text-decoration: none; display: inline-block; }
.dsc-lightbox-download:hover { background: rgba(255, 255, 255, 0.12); }
.dsc-lightbox-close { position: absolute; top: clamp(4px, 0.6vw, 14px); right: clamp(4px, 0.6vw, 14px); z-index: 3; width: clamp(28px, 2.2vw, 48px); height: clamp(28px, 2.2vw, 48px); border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.35); background: transparent; color: #fff; font-size: clamp(13px, 1.1vw, 22px); line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.dsc-lightbox-close:hover { background: rgba(255, 255, 255, 0.12); }
.dsc-lightbox-nav { position: absolute; top: 0; bottom: 0; z-index: 2; width: clamp(64px, 7vw, 128px); display: flex; align-items: center; background: transparent; border: none; color: #fff; font-size: clamp(38px, 3.4vw, 84px); line-height: 1; cursor: pointer; opacity: 0.6; padding: 0; }
.dsc-lightbox-nav:hover { opacity: 1; color: var(--dsw-alias-brand-primary); background: rgba(255, 255, 255, 0.06); }
.dsc-lightbox-nav--prev { left: 0; justify-content: flex-start; padding-left: clamp(14px, 1.8vw, 36px); }
.dsc-lightbox-nav--next { right: 0; justify-content: flex-end; padding-right: clamp(14px, 1.8vw, 36px); }
.dsc-job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsc-job-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dsc-job-mid { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.dsc-job-mid-right { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.dsc-job-bottom { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsc-job-duration { flex: none; }
.dsc-job-progress { color: #3b82f6; font-variant-numeric: tabular-nums; }
.dsc-job-menu { position: relative; flex: none; }
.dsc-job-menu-btn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 15px; line-height: 1; padding: 3px 7px; border-radius: 6px; cursor: pointer; }
.dsc-job-menu-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsc-job-menu-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 950; min-width: 128px; padding: 4px; display: flex; flex-direction: column; gap: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
.dsc-job-menu-pop button { border: none; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; font-size: 13px; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.dsc-job-menu-pop button:hover { background: var(--dsw-alias-bg-layer-3); }
.dsc-job-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; margin-left: auto; flex: 1; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* --- parameter editor --- */
.dsc-params { display: flex; flex-direction: column; gap: 8px; }
.dsc-param-row { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; }
.dsc-param-fields { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsc-param-default { min-width: 0; }
.dsc-param-meta { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dsc-param-random { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsc-param-bool { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsc-param-advanced { display: flex; flex-direction: column; gap: 8px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px; }
`

/** Inject the stylesheet once (idempotent), owned by this plugin for HMR. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-comfyui-styles') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-comfyui-styles'
  style.setAttribute('data-plugin', 'dsh-comfyui')
  style.textContent = CSS
  document.head.append(style)
}
