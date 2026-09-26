<script lang="ts">
    let busy = false;
    let error = '';
    let password = '';
    let showPassword = false;

    async function loginBtn(): Promise<void> {
        busy = true;
        error = '';
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            if (res.ok) {
                window.location.href = '/';
                return;
            }
            const data = (await res.json()) as { error?: string };
            error = data.error || 'Login failed';
        } catch {
            error = 'Request failed';
        } finally {
            busy = false;
        }
    }
</script>

<div class="card bg-base-300 w-full max-w-sm shadow-xl">
    <div class="card-body gap-4">
        <div class="flex items-center gap-3">
            <img src="logo.png" class="h-8 w-8" alt="" />
            <h2 class="text-xl font-bold">Restream SRS</h2>
        </div>
        <fieldset class="fieldset">
            <legend class="fieldset-legend">Username</legend>
            <input
                type="text"
                name="username"
                class="input w-full opacity-60"
                value="admin"
                autocomplete="username"
                readonly />
        </fieldset>
        <fieldset class="fieldset">
            <legend class="fieldset-legend">Password</legend>
            <div class="relative">
                <input
                    type={showPassword ? 'text' : 'password'}
                    bind:value={password}
                    class="input w-full pr-10"
                    placeholder="Enter password"
                    autocomplete="current-password"
                    autofocus
                    onkeydown={(event) => {
                        if (event.key === 'Enter') void loginBtn();
                    }} />
                <button
                    type="button"
                    class="absolute top-1/2 right-2 -translate-y-1/2 opacity-50 hover:opacity-100"
                    onclick={() => (showPassword = !showPassword)}
                    tabindex="-1"
                    aria-label="Toggle password visibility">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class:hidden={showPassword}
                        ><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle
                            cx="12"
                            cy="12"
                            r="3" /></svg>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class:hidden={!showPassword}
                        ><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path
                            d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path
                            d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line
                            x1="2"
                            x2="22"
                            y1="2"
                            y2="22" /></svg>
                </button>
            </div>
        </fieldset>
        {#if error}<p class="text-error text-sm">{error}</p>{/if}
        <button class="btn btn-accent w-full" disabled={busy} onclick={() => void loginBtn()}
            >Sign In</button>
    </div>
</div>
