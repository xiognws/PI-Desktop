// Fenced block renderer for the report markdown the tool emits, plus the
// diagnose narrative. Renders in a scrollable pre so a long report never
// stretches the message column.
import { h, useState } from 'react';
import { Pre, Button, Chip } from './ui.mjs';

const MAX_PREVIEW = 6000;

export function ReportBlock(props) {
  const source = typeof props.source === 'string' ? props.source : '';
  const [expanded, setExpanded] = useState(false);
  const long = source.length > MAX_PREVIEW;
  const shown = expanded || !long ? source : source.slice(0, MAX_PREVIEW) + '\n...';
  return h('div', { className: 'at-root' },
    h('div', { className: 'at-head' },
      h('span', { className: 'at-title' }, 'Autotest report'),
      h(Chip, null, source.length + ' chars'),
      long ? h(Button, { onClick: function () { setExpanded(!expanded); } }, expanded ? 'Collapse' : 'Show all') : null,
    ),
    h(Pre, { text: shown }),
  );
}
