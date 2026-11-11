<template>
  <BackendGuard />
  <router-view />
</template>

<script setup>
import BackendGuard from '@/components/backend-guard.vue'
</script>
