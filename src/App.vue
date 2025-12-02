<script setup lang="ts">
import { onMounted } from 'vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

onMounted(() => {
  // Apply saved theme on mount
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme)
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  }
})
</script>

<template>
  <div>
    <!-- Navbar -->
    <div class="navbar bg-base-100 shadow-lg fixed top-0 z-50">
      <div class="flex-1">
        <router-link to="/" class="btn btn-ghost text-xl">
          WebP2P
        </router-link>
      </div>
      <div class="flex-none">
        <ThemeToggle />
      </div>
    </div>

    <!-- Main content with padding for fixed navbar -->
    <main class="pt-16">
      <router-view />
    </main>
  </div>
</template>
