import { contextBridge, ipcRenderer } from 'electron';
import type { TokenUseApi } from '../src/shared/types';
const api:TokenUseApi={
  snapshot:()=>ipcRenderer.invoke('snapshot'),refresh:()=>ipcRenderer.invoke('refresh'),discover:()=>ipcRenderer.invoke('discover'),
  saveSource:(source)=>ipcRenderer.invoke('saveSource',source),removeSource:(id)=>ipcRenderer.invoke('removeSource',id),
  saveProvider:(provider)=>ipcRenderer.invoke('saveProvider',provider),savePrice:(price)=>ipcRenderer.invoke('savePrice',price),removePrice:(id)=>ipcRenderer.invoke('removePrice',id),
  chooseDirectory:()=>ipcRenderer.invoke('chooseDirectory'),chooseCsv:()=>ipcRenderer.invoke('chooseCsv'),importCsv:(args)=>ipcRenderer.invoke('importCsv',args),
  exportCsv:(events)=>ipcRenderer.invoke('exportCsv',events.map(e=>({id:e.id,sourceId:e.sourceId}))),reassign:(args)=>ipcRenderer.invoke('reassign',args),
  onChanged:(callback)=>{const listener=()=>callback();ipcRenderer.on('changed',listener);return()=>ipcRenderer.removeListener('changed',listener);},
};
contextBridge.exposeInMainWorld('tokenuse',api);
