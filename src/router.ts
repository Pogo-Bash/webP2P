import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Home.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: Home
    },
    {
      path: '/share',
      name: 'share',
      component: () => import('@/views/Share.vue')
    },
    {
      path: '/s/:fileId/:partIndex',
      name: 'seed',
      component: () => import('@/views/Seed.vue')
    },
    {
      path: '/d/:fileId',
      name: 'download',
      component: () => import('@/views/Download.vue')
    }
  ]
})

export default router
