# Rider simulator: drives the real app in headless Chrome with a fake GPS and measures how far the on-screen
# marker is from the true position (metres), saving screenshots to ./shots. Map tiles are a plain grid.
# Needs: pip install playwright pillow, Google Chrome, and npm ci. Usage: python3 scripts/sim/ride_sim.py <label>
import sys, json, io, threading, http.server, functools, os
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
REPO=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..')); label=sys.argv[1] if len(sys.argv)>1 else 'run'; PORT=8765; os.makedirs('shots',exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=http.server.ThreadingHTTPServer(('127.0.0.1',PORT),functools.partial(Q,directory=REPO)); threading.Thread(target=srv.serve_forever,daemon=True).start()
im=Image.new('RGB',(256,256),(238,240,235)); d=ImageDraw.Draw(im); d.rectangle([0,0,255,255],outline=(205,210,200)); b=io.BytesIO(); im.save(b,'PNG'); TILE=b.getvalue()
def demo():
    north=[[100.4,5.3+i*0.001] for i in range(61)]; east=[[100.4+i*0.001,5.36] for i in range(41)]
    st=lambda p,t,m,n:{'geometry':{'coordinates':p},'maneuver':{'type':t,'modifier':m},'name':n}
    return {'distance':10000,'duration':900,'legs':[{'summary':'Laluan A','steps':[st(north,'depart',None,'Jalan Utama'),st(east,'turn','right','Jalan Tol X'),st([east[40],east[40]],'arrive',None,'')]}]}
def handle(route):
    u=route.request.url
    if u.startswith(f'http://127.0.0.1:{PORT}'): return route.continue_()
    if 'leaflet' in u and u.endswith('.css'): return route.fulfill(path=REPO+'/node_modules/leaflet/dist/leaflet.css',content_type='text/css')
    if 'leaflet' in u and u.endswith('.js'): return route.fulfill(path=REPO+'/node_modules/leaflet/dist/leaflet.js',content_type='application/javascript')
    if 'arcgisonline' in u or 'tile.openstreetmap' in u: return route.fulfill(body=TILE,content_type='image/png')
    if 'project-osrm.org' in u: return route.fulfill(body=json.dumps({'code':'Ok','routes':[demo()]}),content_type='application/json',headers={'access-control-allow-origin':'*'})
    return route.abort()
INIT="""
navigator.geolocation.watchPosition=(cb)=>{window.__pos=cb;return 1};navigator.geolocation.clearWatch=()=>{};
navigator.serviceWorker&&(navigator.serviceWorker.register=()=>Promise.reject(new Error('off')));
localStorage.setItem('s9_cartoon','false');localStorage.setItem('s9_tomtom','""');localStorage.setItem('s9_lang','"en"');localStorage.setItem('s9_tipsSeenCar','true');localStorage.setItem('s9_tipsSeenMoto','true');localStorage.setItem('s9_voice','false');
"""
# scenario(t seconds) -> true [lat,lon]. M = metres per degree latitude.
SIM="""
async (cfg)=>{const M=111320,cl=Math.cos(5.36*Math.PI/180);
 const truth=cfg.kind==='turn'?(t)=>{const s=cfg.v*t,toTurn=(5.36-cfg.lat0)*M;return s<toTurn?[cfg.lat0+s/M,100.4]:[5.36,100.4+(s-toTurn)/(M*cl)]}
  :cfg.kind==='miss'?(t)=>[cfg.lat0+cfg.v*t/M,100.4]
  :(t)=>[cfg.lat0,100.4];
 let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-.5};
 const t0=performance.now();const errs=[];let lastFix=-9;const shots=[];
 const fix=(t)=>{const p=truth(Math.max(0,t-cfg.lag));const n=cfg.noise;window.__pos({coords:{latitude:p[0]+rnd()*2*n/M,longitude:p[1]+rnd()*2*n/(M*cl),accuracy:cfg.acc||8,speed:cfg.kind==='stop'?0:cfg.v,heading:null},timestamp:Date.now()-cfg.lag*1000})};
 fix(0);await new Promise(r=>setTimeout(r,300));
 return await new Promise(res=>{const tick=()=>{const t=(performance.now()-t0)/1000;
   if(t-lastFix>=1){lastFix=t;fix(t)}
   const p=truth(t);const e=hav(p[0],p[1],meS.lat,meS.lon);if(t>3)errs.push(e);
   if(t<cfg.dur)requestAnimationFrame(tick);else{errs.sort((a,b)=>a-b);res({n:errs.length,mean:errs.reduce((a,b)=>a+b,0)/errs.length,p95:errs[Math.floor(errs.length*.95)],max:errs[errs.length-1]})}};tick()})}
"""
out={}
with sync_playwright() as pw:
    br=pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    def run(name,cfg,view='h',shot_at=None):
        ctx=br.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
        ctx.add_init_script(INIT+f"localStorage.setItem('s9_view','\"{view}\"');")
        pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.route('**/*',handle)
        pg.goto(f'http://127.0.0.1:{PORT}/index.html'); pg.wait_for_function('!!window.__pos')
        pg.evaluate("(c)=>{window.__pos({coords:{latitude:c.lat0,longitude:100.4,accuracy:8,speed:0,heading:null},timestamp:Date.now()})}",cfg)
        if cfg.get('nav',True):
            pg.evaluate("async()=>{st.dest={lat:5.36,lon:100.44,name:'Gurney Plaza'};await computeRoutes()}")
            pg.wait_for_selector('.rc'); pg.screenshot(path=f'shots/{label}-{name}-0-routes.png')
            pg.wait_for_timeout(cfg.get('wait',700)); pg.evaluate("startNav()"); pg.wait_for_timeout(400)
        res=pg.evaluate(SIM,cfg)
        res['zoom']=pg.evaluate('map.getZoom()'); res['box']=pg.evaluate("(()=>{const r=$('#map').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom),$('#map').style.transform]})()")
        pg.screenshot(path=f'shots/{label}-{name}-1-end.png')
        res['pageErrors']=errs; out[name]=res; ctx.close()
    run('steady',{'kind':'turn','lat0':5.30,'v':20,'lag':0.3,'noise':3,'dur':25})
    run('turn',{'kind':'turn','lat0':5.3555,'v':14,'lag':0.3,'noise':3,'dur':45},view='t')
    run('miss',{'kind':'miss','lat0':5.3585,'v':14,'lag':0.3,'noise':3,'dur':14})
    run('east',{'kind':'turn','lat0':5.3585,'v':14,'lag':0.3,'noise':3,'dur':30})
    run('quick',{'kind':'turn','lat0':5.30,'v':14,'lag':0.3,'noise':3,'dur':6,'wait':0})
    run('stop',{'kind':'stop','lat0':5.31,'v':0,'lag':0,'noise':10,'acc':15,'dur':20,'nav':False})
    br.close()
print(json.dumps(out,indent=1)); json.dump(out,open(f'shots/{label}.json','w'))
