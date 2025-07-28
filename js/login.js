const BACKEND_URL = 'https://autra-backend.onrender.com';

async function handleLogin(event) {
  event.preventDefault();

  const studentCode = document.getElementById('student-code').value.trim().toUpperCase();
  const password = document.getElementById('password').value.trim();
  const errorMessage = document.getElementById('error-message');

  if (!/^[A-Z0-9]+$/.test(studentCode)) {
    errorMessage.textContent = 'Código inválido (solo letras y números)';
    errorMessage.style.display = 'block';
    return;
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentCode, password })
    });

    const data = await response.json();

    if (data.success) {
      console.log('🟢 Login exitoso, studentCode:', data.studentCode);
      localStorage.setItem('studentCode', data.studentCode);
      document.getElementById('device-modal').style.display = 'flex';
    } else {
      console.warn('🔴 Login fallido:', data.message);
      errorMessage.textContent = data.message || 'Credenciales inválidas';
      errorMessage.style.display = 'block';
    }

  } catch (error) {
    console.error('🔥 Error de conexión con backend:', error);
    errorMessage.textContent = 'Error de conexión con el servidor';
    errorMessage.style.display = 'block';
  }
}

function redirectTo(url) {
  window.location.href = url;
}
