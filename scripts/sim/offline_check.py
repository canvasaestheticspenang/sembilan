# Offline check in real Chrome: installs the service worker, cuts the network, reloads, then searches and loads cameras.
# Usage: python3 scripts/sim/offline_check.py
import sys,os,json
os.environ['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS']='1'
sys.argv=['x','off']
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'ride_sim.py')).read().split("out={}")[0])
INIT2="navigator.geolocation.watchPosition=(cb)=>{window.__pos=cb;return 1};navigator.geolocation.clearWatch=()=>{};if(!localStorage.getItem('s9_lang')){localStorage.setItem('s9_cartoon','false');localStorage.setItem('s9_tomtom','\"\"');localStorage.setItem('s9_lang','\"en\"')}"
with sync_playwright() as pw:
    br=pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=br.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True,service_workers='allow')
    ctx.add_init_script(INIT2); ctx.route('**/*',handle)
    pg=ctx.new_page(); pg.set_default_timeout(20000); pg.goto(f'http://127.0.0.1:{PORT}/index.html',wait_until='commit'); pg.wait_for_function('!!window.__pos')
    print("loaded",flush=True); pg.evaluate("navigator.serviceWorker.register('sw.js').then(()=>1)"); pg.wait_for_timeout(9000); print("sw", pg.evaluate("navigator.serviceWorker.getRegistration().then(r=>r&&[!!r.active,!!r.installing,!!r.waiting])"),flush=True)
    print('caches', pg.evaluate("(async()=>{const o={};for(const k of await caches.keys())o[k]=(await (await caches.open(k)).keys()).length;return o})()"))
    ctx.set_offline(True)
    pg.reload(); pg.wait_for_function('!!window.__pos',timeout=15000)
    pg.evaluate("window.__pos({coords:{latitude:5.3,longitude:100.4,accuracy:8,speed:0,heading:null},timestamp:Date.now()})")
    t=pg.evaluate("(async()=>{const t0=performance.now();const r=await geocode('klia');return [Math.round(performance.now()-t0),r.slice(0,2).map(x=>x.name)]})()")
    print('offline search klia', t)
    print('offline cameras', pg.evaluate("SC.load().then(j=>j&&j.c.length)"))
    print('offline poi tile', pg.evaluate("fetch('data/t/5_100.json').then(r=>r.ok)"))
    pg.fill('#qDest','klia'); pg.wait_for_timeout(1500); pg.screenshot(path='shots/offline-search.png')
    br.close()
