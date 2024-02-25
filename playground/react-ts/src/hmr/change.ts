export const render = () => {
  document.body.append(document.createTextNode('heewwwloww'))
}
if (import.meta.hot) {
  import.meta.hot.accept((mod) => mod.render())
}
