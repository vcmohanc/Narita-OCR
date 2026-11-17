(function () {
  const form = document.getElementById('loginForm');
  const userInp = document.getElementById('loginUsername');
  const passInp = document.getElementById('loginPassword');
  const toggleBtn = document.getElementById('loginPwToggle');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const btnText = document.getElementById('loginBtnText');
  const alertEl = document.getElementById('loginAlert');

  function showError(msg) {
    if (!alertEl) return;
    alertEl.textContent = msg;
    alertEl.classList.remove('hidden');
  }

  function clearError() {
    if (!alertEl) return;
    alertEl.textContent = '';
    alertEl.classList.add('hidden');
  }

  toggleBtn?.addEventListener('click', () => {
    if (!passInp) return;
    const isPw = passInp.type === 'password';
    passInp.type = isPw ? 'text' : 'password';
    toggleBtn.textContent = isPw ? '🙈' : '👁';
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = (userInp?.value || '').trim();
    const password = passInp?.value || '';

    if (!username || !password) {
      showError('ユーザー名とパスワードを入力してください。');
      (!username ? userInp : passInp)?.focus();
      return;
    }

    submitBtn.disabled = true;
    btnText.textContent = '認証中…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.detail || 'ログインに失敗しました。');
        submitBtn.disabled = false;
        btnText.textContent = 'ログイン / Sign In';
        return;
      }
      window.location.replace('/');
    } catch {
      showError('サーバーに接続できませんでした。もう一度お試しください。');
      submitBtn.disabled = false;
      btnText.textContent = 'ログイン / Sign In';
    }
  });
})();
