document.querySelector("#loginForm").onsubmit = async event => {
  event.preventDefault();
  const error = document.querySelector("#error");
  const submitBtn = document.querySelector("#submit");
  const loginInput = document.querySelector("#login");
  const passwordInput = document.querySelector("#password");
  error.textContent = "";
  const body = {login: loginInput.value, password: passwordInput.value};
  submitBtn.disabled = true;
  loginInput.disabled = true;
  passwordInput.disabled = true;
  submitBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Signing in…';
  try {
    const response = await fetch("/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to continue.");
    location.href = "/";
  } catch (e) {
    error.textContent = e.message;
    submitBtn.disabled = false;
    loginInput.disabled = false;
    passwordInput.disabled = false;
    submitBtn.textContent = "Sign in";
  }
};

