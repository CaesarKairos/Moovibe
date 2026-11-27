export const topGlobalAdminMarkup = `
<details id="top-global-admin" class="section" style="padding:18px">
  <summary><strong>TOP 50 GLOBAL</strong></summary>
  <p id="top-global-status" role="status"></p>
  <p id="top-global-refresh" role="status"></p>
  <label>Ranking autorizado (JSON ou CSV do Spotify Charts)
    <textarea id="top-global-input" rows="5" style="display:block;width:100%"></textarea>
  </label>
  <label>Data de referência do CSV <input type="date" id="top-global-csv-date"></label>
  <label><input type="checkbox" id="top-global-authorized"> Tenho autorização para armazenar e publicar estes dados.</label>
  <div class="toolbar">
    <button type="button" data-top-global="import">Atualizar ranking agora</button>
    <button type="button" data-top-global="refresh">Atualizar Apple Music Brasil agora</button>
    <button type="button" data-top-global="probe">Testar acesso Spotify</button>
    <button type="button" data-top-global="process">Processar uma recomendação pendente</button>
    <button type="button" data-top-global="pause">Pausar processamento</button>
    <button type="button" data-top-global="resume">Retomar processamento</button>
    <button type="button" data-top-global="regenerate_all">Gerar novamente todas</button>
  </div>
  <label><input type="checkbox" id="top-global-duplicates"> Permitir filmes repetidos</label>
  <label>Faixa <select id="top-global-track"></select></label>
  <button type="button" data-top-global="regenerate">Gerar novamente a faixa</button>
  <pre id="top-global-failures" style="white-space:pre-wrap"></pre>
</details>`;

export function topGlobalAdminScript(csrf) {
  return `(() => {
    const section = document.querySelector('#top-global-admin');
    const status = section.querySelector('#top-global-status');
    const refreshStatus = section.querySelector('#top-global-refresh');
    const duplicates = section.querySelector('#top-global-duplicates');
    const tracks = section.querySelector('#top-global-track');
    const failures = section.querySelector('#top-global-failures');
    let busy = false;
    async function update(body) {
      if (busy) return;
      busy = true;
      status.textContent = 'Aguarde…';
      try {
        const result = await fetch('./api/top-global', body ? {
          method:'POST', headers:{'content-type':'application/json','x-csrf-token':${JSON.stringify(csrf)}},
          body:JSON.stringify(body)
        } : {});
        const data = await result.json();
        if (data.refresh) {
          const r = data.refresh;
          refreshStatus.textContent = [
            'Apple Music · Brasil', 'Coleta diária às 09:00 UTC',
            'Última tentativa: '+r.last_attempt, 'Último sucesso: '+(r.last_success || '—'),
            'Faixas: '+r.count, 'Último erro: '+(r.error || '—'),
          ].join(' · ');
          if (body?.action === 'refresh') { status.textContent = r.error || 'Atualização concluída.'; return; }
        }
        if (!result.ok) throw Error(data.error || result.status);
        if (data.spotify) {
          status.textContent = Object.entries(data.spotify).map(([name,value]) => name+': HTTP '+value.status+' · item: '+(value.has_item?'sim':'não')).join(' | ');
          return;
        }
        status.textContent = [
          'Fonte: '+(data.source || 'aguardando importação autorizada'),
          'Atualizado: '+(data.updated_at || '—'),
          'Associadas: '+data.associated+'/50', 'Pendentes: '+data.pending,
          'Tentativas hoje: '+data.attempts+'/'+data.daily_limit,
          data.paused?'Pausado':'Disponível para processamento manual',
          'Próxima atualização: —',
        ].join(' · ');
        duplicates.checked = data.allow_duplicates;
        tracks.replaceChildren(...data.tracks.map(t => new Option(t.position+'. '+t.title+' — '+t.artist,t.spotify_id)));
        failures.textContent = data.tracks.filter(t=>t.failure).map(t=>t.title+' · '+t.failure+' · '+t.attempted_at).join('\\n');
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; }
    }
    section.addEventListener('toggle', () => { if (section.open) update(); });
    duplicates.addEventListener('change', () => update({action:'duplicates',allow:duplicates.checked}));
    section.addEventListener('click', event => {
      const action = event.target.closest('[data-top-global]')?.dataset.topGlobal;
      if (!action || busy) return;
      if (action === 'import') {
        try {
          const raw = section.querySelector('#top-global-input').value.trim();
          const feed = raw.startsWith('{') ? JSON.parse(raw) : {
            source:'charts', reference_date:section.querySelector('#top-global-csv-date').value, csv:raw,
          };
          update({...feed,action,authorized:section.querySelector('#top-global-authorized').checked});
        } catch { status.textContent = 'JSON inválido.'; }
      } else if (action === 'regenerate_all') {
        if (confirm('Marcar as 50 recomendações para regeneração gradual?')) update({action,confirm:true});
      } else update({action,spotify_id:tracks.value});
    });
  })();`;
}
