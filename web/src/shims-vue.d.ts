// Lets plain TypeScript tooling (type-aware lint) resolve .vue imports; vue-tsc reads the files.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
