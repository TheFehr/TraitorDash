// Asks before a form that says so is sent: <form data-confirm="Delete this?">. A page that has such a
// form loads this file; there is no inline script on the pages (their policy does not allow one).
document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement
  const question = form?.dataset?.confirm
  if (question && !window.confirm(question)) e.preventDefault()
})
