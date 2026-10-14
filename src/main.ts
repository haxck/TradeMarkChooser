import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { registerWebMCP } from './lib/webmcp'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// 注册 WebMCP 工具（浏览器不支持时自动跳过）
registerWebMCP()

export default app
