export function renderNav(active) {
  const links = [
    ['research', '/', 'Research'],
    ['history', '/history.html', 'History'],
    ['wiki', '/wiki.html', 'Wiki'],
  ];
  return `
    <nav class="nav">
      ${links.map(([id, href, label]) => (
        id === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`
      )).join('')}
    </nav>
  `;
}
