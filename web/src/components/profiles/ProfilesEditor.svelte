<script lang="ts">
  // Household profiles for the TV: who may do what there, and their PINs. Edited on a computer or
  // phone; the TV asks "Who is watching?" once any profile exists.
  import { ACTIONS, COLORS, hashPin, newProfile, profiles, type Action, type Profile } from '../../lib/profiles.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { mydrive } from '../../lib/mydrive.svelte.ts';
  import { FOLDER_MIME, type DFile } from '../../lib/gdrive.ts';

  // Folder picker: type part of a folder's name, pick from what Drive finds.
  $effect(() => { void mydrive.start(); });
  let findFor = $state('');
  let findText = $state('');
  let found = $state<DFile[]>([]);
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  function find(text: string) {
    findText = text;
    clearTimeout(findTimer);
    const t = text.trim();
    if (!t || !mydrive.drive) { found = []; return; }
    findTimer = setTimeout(async () => {
      try {
        const l = await mydrive.drive!.query(`mimeType = '${FOLDER_MIME}' and name contains '${t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`, { orderBy: 'name_natural', max: 12 });
        if (findText === text) found = l;
      } catch { found = []; }
    }, 250);
  }
  function addFolder(p: Profile, f: DFile) {
    if (!(p.folders ?? []).some((x) => x.id === f.id)) p.folders = [...(p.folders ?? []), { id: f.id, name: f.name }];
    findFor = ''; findText = ''; found = []; touch();
  }
  function dropFolder(p: Profile, id: string) { p.folders = (p.folders ?? []).filter((x) => x.id !== id); touch(); }

  let draft = $state<Profile[]>([]);
  let pins = $state<Record<string, string>>({});
  let dirty = $state(false);
  let saving = $state(false);
  $effect(() => { if (!dirty) draft = structuredClone(profiles.list); });

  const touch = () => (dirty = true);
  function add() { draft = [...draft, newProfile(draft.length ? `Person ${draft.length + 1}` : 'Me', draft.length)]; if (draft.length === 1) draft[0]!.can = { comment: true, share: true, edit: true, bin: true }; touch(); }
  function remove(p: Profile) { draft = draft.filter((x) => x !== p); touch(); }
  function toggle(p: Profile, a: Action) { p.can[a] = !p.can[a]; touch(); }
  function togglePin(p: Profile, a: Action) { p.pinFor = p.pinFor.includes(a) ? p.pinFor.filter((x) => x !== a) : [...p.pinFor, a]; touch(); }

  async function save() {
    saving = true;
    try {
      for (const p of draft) {
        const pin = pins[p.id]?.trim();
        if (pin === undefined || pin === '') continue;
        if (!/^\d{4}$/.test(pin)) throw new Error(`${p.name}: the PIN must be 4 digits`);
        p.pin = await hashPin(pin);
      }
      await profiles.save($state.snapshot(draft) as Profile[]);
      pins = {};
      dirty = false;
      toast.show('Profiles saved; the TV picks them up at once.', undefined, 2500);
    } catch (e) { toast.show((e as Error).message); }
    saving = false;
  }
</script>

<section class="stack" style="gap:0.8rem">
  <div class="row spread">
    <div>
      <h2>TV profiles</h2>
      <p class="muted small" style="margin:0.2rem 0 0">For a TV that several people use. Set them up here, on a computer or phone; the TV then asks “Who is watching?”. Each profile chooses which folders it sees and what it may do there. A PIN, once typed on the TV, is not asked again for an hour. No profiles = everything allowed.</p>
    </div>
    <button onclick={add}>Add profile</button>
  </div>

  {#if draft.length}
    <div class="profiles">
      {#each draft as p (p.id)}
        <div class="card prof">
          <div class="row">
            <span class="av" style:background={p.color}>{p.name[0]?.toUpperCase() ?? '?'}</span>
            <input class="name" bind:value={p.name} oninput={touch} maxlength="30" aria-label="Name" />
            <div class="colors">{#each COLORS as c}<button class="c" class:on={p.color === c} style:background={c} aria-label="Colour" onclick={() => { p.color = c; touch(); }}></button>{/each}</div>
            <span class="grow"></span>
            <button class="ghost danger small" onclick={() => remove(p)}>Remove</button>
          </div>
          <table>
            <thead><tr><th>May</th>{#each ACTIONS as a}<th title={a.hint}>{a.label}</th>{/each}</tr></thead>
            <tbody>
              <tr><td class="muted small">allowed</td>{#each ACTIONS as a}<td><input type="checkbox" checked={p.can[a.id]} onchange={() => toggle(p, a.id)} /></td>{/each}</tr>
              <tr><td class="muted small">ask PIN</td>{#each ACTIONS as a}<td><input type="checkbox" checked={p.pinFor.includes(a.id)} disabled={!p.can[a.id]} onchange={() => togglePin(p, a.id)} /></td>{/each}</tr>
            </tbody>
          </table>
          <div class="stack small" style="gap:0.4rem">
            <div class="row" style="flex-wrap:wrap;gap:0.4rem">
              <span class="muted">Sees:</span>
              {#if !p.folders?.length}<span>all of Drive</span>{/if}
              {#each p.folders ?? [] as f (f.id)}<span class="chip">📁 {f.name} <button class="link small" aria-label="Remove {f.name}" onclick={() => dropFolder(p, f.id)}>✕</button></span>{/each}
              {#if findFor !== p.id}<button class="link small" onclick={() => { findFor = p.id; findText = ''; found = []; }}>{p.folders?.length ? 'add folder' : 'only some folders…'}</button>{/if}
            </div>
            {#if findFor === p.id}
              <div class="row" style="gap:0.4rem"><input class="find" placeholder="Folder name…" value={findText} oninput={(e) => find((e.currentTarget as HTMLInputElement).value)} /><button class="ghost small" onclick={() => (findFor = '')}>Done</button></div>
              {#if found.length}<div class="found">{#each found as f (f.id)}<button class="ghost small" onclick={() => addFolder(p, f)}>📁 {f.name}</button>{/each}</div>
              {:else if findText.trim()}<span class="faint">No folder by that name yet…</span>{/if}
            {/if}
          </div>
          <div class="row small">
            <span class="muted">PIN:</span>
            {#if p.pin && pins[p.id] === undefined}<span>set</span> <button class="link small" onclick={() => { pins[p.id] = ''; }}>change</button> <button class="link small" onclick={() => { p.pin = ''; touch(); }}>remove</button>
            {:else}<input class="pin" inputmode="numeric" maxlength="4" placeholder="4 digits" bind:value={pins[p.id]} oninput={touch} />{/if}
            <span class="faint">Viewing is always allowed. With a PIN, switching to this profile on the TV asks for it too.</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  {#if dirty}<div class="row"><button class="primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save profiles'}</button><button class="ghost" onclick={() => { dirty = false; pins = {}; }}>Discard</button></div>{/if}
</section>

<style>
  .profiles { display: grid; gap: 0.8rem; }
  .prof { display: grid; gap: 0.8rem; }
  .av { width: 2.2rem; height: 2.2rem; border-radius: 0.6rem; display: grid; place-items: center; font-weight: 800; color: #0d0f12; flex: none; }
  .name { width: 12rem; font-weight: 600; }
  .colors { display: flex; gap: 0.3rem; }
  .c { width: 1.2rem; height: 1.2rem; padding: 0; border-radius: 50%; border: 2px solid transparent; }
  .c.on { border-color: #fff; }
  td, th { text-align: center; }
  td:first-child, th:first-child { text-align: left; }
  .pin { width: 7rem; letter-spacing: 0.3em; }
  .chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.55rem; border-radius: 99px; background: var(--panel-2); }
  .find { width: 16rem; }
  .found { display: flex; flex-wrap: wrap; gap: 0.3rem; }
</style>
