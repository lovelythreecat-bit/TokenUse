import React from 'react';import {createRoot} from 'react-dom/client';
import App from './App';import './styles.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string|null}>{
 state={error:null as string|null};static getDerivedStateFromError(error:Error){return {error:error.message};}
 render(){if(this.state.error)return <div className="fatal"><h1>界面暂时无法显示</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>重新加载</button><p>统计数据仍保存在本机。</p></div>;return this.props.children;}
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
