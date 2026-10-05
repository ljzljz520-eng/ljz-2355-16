<template>
  <Layout>
    <template #nav-bar-content-after>
      <SearchSnippets />
    </template>
  </Layout>
</template>

<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import SearchSnippets from './SearchSnippets.vue'

const { Layout } = DefaultTheme
</script>
