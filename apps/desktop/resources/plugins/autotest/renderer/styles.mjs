// Host design tokens only (no hard-coded palette, no global selectors).
export const AUTOTEST_CSS = `
.at-root { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--ds-text-primary); }
.at-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.at-title { font-weight: 600; }
.at-muted { color: var(--ds-text-muted); }
.at-chip { background: var(--ds-bg-chip); border-radius: 10px; padding: 1px 8px; font-size: 12px; color: var(--ds-text-secondary); white-space: nowrap; }
.at-rail { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.at-stage { border: 1px solid var(--ds-border-default); border-radius: 6px; padding: 2px 8px; font-size: 12px; color: var(--ds-text-secondary); white-space: nowrap; }
.at-stage[data-status=\"done\"] { border-color: var(--ds-success); color: var(--ds-success); }
.at-stage[data-status=\"running\"] { border-color: var(--ds-accent); color: var(--ds-accent); }
.at-stage[data-status=\"awaiting_review\"] { border-color: var(--ds-warning); color: var(--ds-warning); }
.at-stage[data-status=\"failed\"] { border-color: var(--ds-error); color: var(--ds-error); }
.at-stage[data-status=\"blocked\"] { color: var(--ds-text-muted); border-style: dashed; }
.at-stage[data-current=\"yes\"] { font-weight: 600; }
.at-table { width: 100%; border-collapse: collapse; }
.at-table th, .at-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--ds-border-default); vertical-align: top; }
.at-table th { font-size: 12px; color: var(--ds-text-muted); font-weight: 500; }
.at-actions { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.at-btn { border: 1px solid var(--ds-border-default); background: transparent; color: var(--ds-text-primary); border-radius: 6px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.at-btn:hover { background: var(--ds-bg-hover); }
.at-btn[data-kind=\"primary\"] { border-color: var(--ds-accent); color: var(--ds-accent); }
.at-btn[data-kind=\"danger\"] { border-color: var(--ds-error); color: var(--ds-error); }
.at-btn:disabled { opacity: .5; cursor: default; }
.at-input { border: 1px solid var(--ds-border-default); background: transparent; color: var(--ds-text-primary); border-radius: 6px; padding: 2px 6px; font-size: 12px; width: 100%; box-sizing: border-box; }
.at-gate { border: 1px solid var(--ds-warning); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.at-gate-title { color: var(--ds-warning); font-weight: 600; }
.at-danger { border: 1px solid var(--ds-error); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.at-danger-title { color: var(--ds-error); font-weight: 600; }
.at-ok { color: var(--ds-success); }
.at-bad { color: var(--ds-error); }
.at-warn { color: var(--ds-warning); }
.at-pre { margin: 0; padding: 6px; background: var(--ds-bg-chip); border-radius: 6px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
.at-list { margin: 0; padding-left: 18px; }
.at-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; font-size: 12px; }
.at-kv dt { color: var(--ds-text-muted); }
.at-kv dd { margin: 0; }
.at-empty { color: var(--ds-text-muted); font-size: 12px; }
.at-editable { min-width: 120px; }
`;
