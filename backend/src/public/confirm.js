document.addEventListener("submit",(t)=>{let e=t.target?.dataset?.confirm;if(e&&!window.confirm(e))t.preventDefault()});
