let mode = "login";
const setMode = next => {
  mode = next;
  const register = mode === "register";
  document.querySelector("#intro").textContent = register ? "Create your account to join the shared planner." : "Sign in to access the shared Instagram planner.";
  document.querySelector("#nameField").classList.toggle("hidden", !register);
  document.querySelector("#roleField").classList.toggle("hidden", !register);
  document.querySelector("#loginField").classList.toggle("hidden", register);
  document.querySelector("#login").required = !register;
  document.querySelector("#name").required = register;
  document.querySelector("#submit").textContent = register ? "Create account" : "Sign in";
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.mode === mode));
};
document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => setMode(tab.dataset.mode));
document.querySelector("#loginForm").onsubmit = async event => {
  event.preventDefault();
  const error = document.querySelector("#error");
  error.textContent = "";
  const body = mode === "register"
    ? {name: document.querySelector("#name").value, role: document.querySelector("#role").value, password: document.querySelector("#password").value}
    : {login: document.querySelector("#login").value, password: document.querySelector("#password").value};
  try {
    const response = await fetch(mode === "register" ? "/auth/register" : "/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to continue.");
    location.href = "/";
  } catch (e) { error.textContent = e.message; }
};
