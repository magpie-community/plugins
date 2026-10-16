"""Render documentation with synthetic data; never read installed user settings."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
output = root / 'docs/images'
output.mkdir(parents=True, exist_ok=True)
when = 1792152000000
providers = [{'id': 'demo', 'name': '演示供应商 · 日常开发'}, {'id': 'backup', 'name': '备用供应商'},
             {'id': 'team', 'name': '团队网关'}]
options = {'providers': {'magpie:demo': {'historyFilter': True, 'preserveEncryptedInclude': True}}, 'aliases': {}}
target = {'id': 'demo-target', 'model': 'demo/gpt-6-astra', 'expected': 'gpt-6-astra', 'effort': 'high',
    'mode': 'manual', 'intervalMinutes': 30, 'paused': False, 'running': False, 'lastChecked': when,
    'lastResult': 'matched', 'stale': False, 'routeChanged': False}
record = {'id': 'demo-record', 'targetId': target['id'], 'model': target['model'], 'expected': target['expected'],
    'effort': 'high', 'status': 'matched', 'reason': '演示数据：三份样本与目标指纹相符；不代表模型身份认证。',
    'startedAt': when, 'finishedAt': when + 10000, 'rounds': [{'samples': []}]}
state = {'version': '0.2.0', 'health': '', 'targets': [target],
    'history': [{**record, 'id': 'demo-record-' + str(i), 'startedAt': when - i * 1800000} for i in range(16)],
    'currentModel': {'model': target['model'], 'requestedModel': 'group/coding', 'reportedModel': 'gpt-6-astra',
        'effort': 'high', 'source': 'request', 'observedAt': '2026-10-16T12:00:00Z'},
    'candidates': ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'], 'bankVersion': '6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2',
    'daily': {'used': 3, 'limit': 60, 'day': '2026-10-16'}, 'connection': {'url': 'http://127.0.0.1:3425', 'hasKey': False}}


def fulfill_asset(route, asset):
    route.fulfill(content_type={'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'}[asset.suffix], body=asset.read_bytes())


def console_route(route):
    assert route.request.method == 'GET', 'Screenshot must not save settings or call a model'
    pathname = route.request.url.split('19998', 1)[-1]
    value = {'/api/state': state, '/api/models': {'models': ['demo/gpt-6-astra', 'backup/gpt-6-luna']},
             '/api/filter': {'options': options, 'providers': providers, 'enabled': True}}.get(pathname)
    if value is not None:
        return route.fulfill(content_type='application/json', body=json.dumps(value))
    asset = root / ('history/page/settings.js' if pathname == '/history-settings.js' else 'web/' + ('index.html' if pathname == '/' else pathname.lstrip('/')))
    if asset.is_file():
        return fulfill_asset(route, asset)
    route.abort()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 1050}, timezone_id='Asia/Shanghai')
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/*', console_route)
    page.goto('http://127.0.0.1:19998/')
    expect(page.locator('#currentModel')).to_have_text(target['model'])
    for theme in ('light', 'dark'):
        if theme == 'dark':
            page.locator('#themeToggle').click()
        expect(page.locator('html')).to_have_attribute('data-theme', theme)
        page.screenshot(path=str(output / ('monitor-' + theme + '.png')), animations='disabled')
    page.locator('#themeToggle').click()
    page.locator('#add').click()
    expect(page.locator('#targetDialog')).to_be_visible()
    page.screenshot(path=str(output / 'monitor-settings.png'), animations='disabled')
    page.locator('#cancelTarget').click()
    for view, wait in [('filters', '#filterRows .filter-row'), ('history', '#historyRows tr')]:
        page.locator('[data-view=' + view + ']').click()
        expect(page.locator(wait).first).to_be_visible()
        page.screenshot(path=str(output / (view + '.png')), animations='disabled')
    page.locator('[data-view=targets]').click()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(output / 'monitor-mobile.png'), full_page=True, animations='disabled')
    # A mocked official bridge renders the native page with no Magpie login or requests.
    bridge = 'globalThis.magpie={ready:Promise.resolve({lang:"zh"}),onTheme(){},read:async()=>'
    bridge += json.dumps(providers) + ',options:{get:async()=>('+json.dumps(options)+'),set:async()=>{throw Error("read only screenshot")}}};'

    def native_route(route):
        assert route.request.method == 'GET'
        name = route.request.url.split('19997/', 1)[-1]
        if name == '_magpie/bridge.js':
            return route.fulfill(content_type='text/javascript', body=bridge)
        return fulfill_asset(route, root / 'history/page' / (name or 'index.html'))

    native = browser.new_page(viewport={'width': 1200, 'height': 1050})
    native.on('pageerror', lambda e: errors.append(str(e)))
    native.route('**/*', native_route)
    native.goto('http://127.0.0.1:19997/')
    try:
        expect(native.locator('#providers .provider')).to_have_count(3)
    except AssertionError:
        raise AssertionError({'notice': native.locator('#notice').inner_text(), 'errors': errors})
    expect(native.locator('[data-t=scope]')).to_contain_text('无需登录或打开独立工作台')
    native.screenshot(path=str(output / 'native-filter.png'), animations='disabled')
    assert not errors, errors
    browser.close()
print(json.dumps({'screenshots': sorted(f.name for f in output.glob('*.png')), 'data': 'synthetic', 'modelRequests': 0}))
