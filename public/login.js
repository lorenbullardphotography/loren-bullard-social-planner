document.querySelector("#loginForm").onsubmit = async event => {
  event.preventDefault();
  const error = document.querySelector("#error");
  error.textContent = "";
  const body = {login: document.querySelector("#login").value, password: document.querySelector("#password").value};
  try {
    const response = await fetch("/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to continue.");
    location.href = "/";
  } catch (e) { error.textContent = e.message; }
};
