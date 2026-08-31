document.querySelector("#loginForm").onsubmit = async event => {
  event.preventDefault();
  const error = document.querySelector("#error");
  error.textContent = "";
  const response = await fetch("/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({password:document.querySelector("#password").value})});
  if (!response.ok) {
    error.textContent = "That password didn’t work.";
    return;
  }
  location.href = "/";
};
