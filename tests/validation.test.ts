import { expect, it } from 'vitest';
import { validateSource, validatePrice, validateProvider } from '../electron/validation';
it('rejects remote share scanning and ambiguous relative paths',()=>{
 const s={id:'s',name:'Source',tool:'claude',kind:'local',path:'\\\\server\\share',enabled:true,included:true,defaultProviderId:null};
 expect(()=>validateSource(s)).toThrow();expect(()=>validateSource({...s,path:'../secret'})).toThrow();
 expect(()=>validateSource({...s,path:'//server/share'})).toThrow();
 expect(()=>validateSource({...s,path:'//wsl.localhost/Ubuntu/home/me/.claude'})).toThrow();
 expect(validateSource({...s,kind:'wsl',path:'//wsl.localhost/Ubuntu/home/me/.claude'}).path).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude');
 expect(validateSource({...s,path:'C:\\Users\\me\\.claude\\projects'}).path).toBe('C:\\Users\\me\\.claude\\projects');
});
it('does not accept negative prices or executable URLs',()=>{
 expect(()=>validatePrice({id:'p',providerId:'a',model:'m',currency:'CNY',effectiveDate:'2026-09-14',rates:{input:-1},reasoningFallback:true})).toThrow();
 expect(()=>validateProvider({id:'p',name:'p',website:'javascript:alert(1)',pricingUrl:'',baseUrl:'',protocol:'',enabled:true,aliases:{},hints:[]})).toThrow();
});
