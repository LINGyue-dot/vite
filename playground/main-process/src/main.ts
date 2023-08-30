import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import getName from './utils'

export interface NameProp {
  name: string
}
console.log(getName())
createApp(App).mount('#app')
