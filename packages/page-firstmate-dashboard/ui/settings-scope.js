(() => {
  const choices = [
    { value: 'all', label: '全部 Harness' },
    { value: 'common', label: '通用' },
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'pi', label: 'Pi / Pi Signed' },
  ];
  function matches(item, scope) {
    const tools = item.harnesses;
    if (scope === 'all') return true;
    if (!Array.isArray(tools)) return scope === 'common';
    if (scope === 'common') return tools.length === 0;
    return tools.length === 0 || tools.includes(scope) || scope === 'pi' && tools.includes('pi-signed');
  }
  window.FMSettingScopes = { choices, matches };
})();
