class StipsPanelEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this._hass = null;
    this.screens = [];
    this.templates = [];
    this.groups = [];
    this.profiles = [];
    this.fleetSummary = {screens:0,online:0,device_owner:0,current_version:0,updates_pending:0,problems:0,latest_version:''};
    this.latestUpdate = null;
    this.fleetSelected = [];
    this.otaProgress = '';
    this.selectedId = '';
    this.detail = null;
    this.draft = null;
    this.draftSource = '';
    this.projectSpace = 'dashboards';
    this.dashIndex = 0;
    this.pageIndex = 0;
    this.selectedCardId = '';
    this.message = '';
    this.busy = false;
    this.dragCardId = null;
    this.dragFloating = false;
    this._uiScroll = null;
    this._openDetails = null;
    this.entityRegistry = [];
    this.areas = [];
    this.devices = [];
    this.picker = null;
    this.previewProfile = 'actual';
    this.previewOrientation = 'screen';
    this._entityCatalogCache = null;
    this._presenceTimer = null;
  }

  connectedCallback() {
    if (!this._presenceTimer) {
      this._presenceTimer = setInterval(() => {
        if (this.screens.length) this.render();
      }, 15000);
    }
  }

  disconnectedCallback() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  set hass(value) {
    const first = !this._hass;
    this._hass = value;
    this._entityCatalogCache = null;
    if (first) this.refresh(false);
  }
  get hass() { return this._hass; }
  set panel(_) {}
  set narrow(_) {}
  set route(_) {}

  async call(msg) {
    if (!this._hass) throw new Error('Home Assistant connection is not ready');
    return this._hass.connection.sendMessagePromise(msg);
  }

  async loadEntityCatalog() {
    try {
      const [display, areas, devices] = await Promise.all([
        this.call({type:'config/entity_registry/list_for_display'}).catch(async () => {
          const full = await this.call({type:'config/entity_registry/list'});
          return {entities:(full || []).map(e => ({
            ei:e.entity_id, ai:e.area_id, di:e.device_id, en:e.name || e.original_name || ''
          }))};
        }),
        this.call({type:'config/area_registry/list'}).catch(() => []),
        this.call({type:'config/device_registry/list'}).catch(() => []),
      ]);
      this.entityRegistry = display?.entities || [];
      this.areas = Array.isArray(areas) ? areas : [];
      this.devices = Array.isArray(devices) ? devices : [];
      this._entityCatalogCache = null;
    } catch (e) {
      console.warn('STIPS entity catalog fallback:', e);
      this.entityRegistry = [];
      this.areas = [];
      this.devices = [];
      this._entityCatalogCache = null;
    }
  }

  async refresh(preserveDraft=true) {
    try {
      this.busy = true;
      const [s, t, g, pr] = await Promise.all([
        this.call({type:'stips_panel/list_screens'}),
        this.call({type:'stips_panel/list_templates'}),
        this.call({type:'stips_panel/list_groups'}).catch(()=>({groups:[]})),
        this.call({type:'stips_panel/list_profiles'}).catch(()=>({profiles:[]})),
        this.loadEntityCatalog(),
      ]);
      this.screens = s.screens || [];
      this.templates = t.templates || [];
      this.groups = g.groups || [];
      this.profiles = pr.profiles || [];
      this.fleetSummary = s.summary || this.fleetSummary;
      this.latestUpdate = s.latest_update || null;
      this.fleetSelected = this.fleetSelected.filter(id=>this.screens.some(x=>x.screen_id===id));
      if (!this.selectedId && this.screens.length) this.selectedId = this.screens[0].screen_id;
      if (this.selectedId) {
        if (preserveDraft && this.draft) {
          this.detail = await this.call({type:'stips_panel/get_screen', screen_id:this.selectedId});
        } else {
          await this.loadScreen(this.selectedId, false);
        }
      }
      this.busy = false;
      if (preserveDraft && this.draft) this.message = 'Screen status and Home Assistant entities refreshed. Your current draft was kept.';
      this.render();
    } catch (e) { this.fail(e); }
  }

  async loadScreen(id, render=true) {
    this.selectedId = id;
    this.detail = await this.call({type:'stips_panel/get_screen', screen_id:id});
    const desired = this.detail?.desired?.project;
    const current = this.detail?.screen?.current_project;
    this.draft = structuredClone(desired || current || null);
    this.draftSource = desired ? 'desired' : (current ? 'screen' : '');
    this.dashIndex = 0;
    this.pageIndex = 0;
    this.selectedCardId = '';
    this.projectSpace = 'dashboards';
    const savedPanel=this.draft?.panel||{};
    this.previewProfile=this.screenProfiles().some(p=>p.key===savedPanel.hardwareProfile)?savedPanel.hardwareProfile:'actual';
    this.previewOrientation=savedPanel.autoRotate===false ? (String(savedPanel.orientation||'Landscape').toLowerCase().startsWith('p')?'Portrait':'Landscape') : 'screen';
    this.message = this.draft ? '' : 'This panel has not uploaded a dashboard snapshot yet.';
    if (render) this.render();
  }

  mergeScreenMetadata(project, screen) {
    if (!project || !screen) return project;
    const p = project.panel ||= {};
    if (typeof screen.kiosk === 'boolean') p.kioskEnabled = screen.kiosk;
    if (typeof screen.show_top_bar === 'boolean') p.showTopBar = screen.show_top_bar;
    if (typeof screen.show_navigation === 'boolean') p.showNavigation = screen.show_navigation;
    if (typeof screen.show_floating_button === 'boolean') p.showFloatingUiHandle = screen.show_floating_button;
    if (typeof screen.floating_button_opacity === 'number') p.floatingButtonOpacity = screen.floating_button_opacity;
    p.floatingButton ||= {};
    if (typeof screen.floating_button_size_dp === 'number') p.floatingButton.sizeDp = screen.floating_button_size_dp;
    if (typeof screen.floating_button_position_x === 'number') p.floatingButton.positionX = screen.floating_button_position_x;
    if (typeof screen.floating_button_position_y === 'number') p.floatingButton.positionY = screen.floating_button_position_y;
    if (typeof screen.auto_rotate === 'boolean') p.autoRotate = screen.auto_rotate;
    if (screen.orientation) p.orientation = screen.orientation;
    if (screen.hardware_profile) p.hardwareProfile = screen.hardware_profile;
    if (screen.performance_mode) p.performanceMode = screen.performance_mode;
    return project;
  }

  async syncFromScreen() {
    if (!this.selectedId) return;
    this.busy = true;
    this.render();
    try {
      const [detail] = await Promise.all([
        this.call({type:'stips_panel/get_screen', screen_id:this.selectedId}),
        this.loadEntityCatalog(),
      ]);
      this.detail = detail;
      const current = detail?.screen?.current_project;
      if (!current) {
        this.busy = false;
        this.message = 'This screen has not uploaded a current project snapshot yet.';
        this.render();
        return;
      }
      this.draft = this.mergeScreenMetadata(structuredClone(current), detail.screen);
      this.draftSource = 'screen';
      this.dashIndex = 0;
      this.pageIndex = 0;
      this.selectedCardId = '';
      this.projectSpace = 'dashboards';
      const savedPanel=this.draft?.panel||{};
      this.previewProfile=this.screenProfiles().some(p=>p.key===savedPanel.hardwareProfile)?savedPanel.hardwareProfile:'actual';
      this.previewOrientation=savedPanel.autoRotate===false ? (String(savedPanel.orientation||'Landscape').toLowerCase().startsWith('p')?'Portrait':'Landscape') : 'screen';
      this.busy = false;
      const seen = (detail.screen?.last_seen || '').replace('T',' ').slice(0,19);
      this.message = `Loaded the settings and dashboard currently reported by this screen${seen ? ` (${seen} UTC)` : ''}. Push only after making changes.`;
      this.render();
    } catch(e) { this.fail(e); }
  }

  fail(e) {
    console.error(e);
    this.busy = false;
    this.message = e?.message || String(e);
    this.render();
  }
  note(text) { this.message = text; this.render(); }

  get dashboardList() { return this.draft?.[this.projectSpace] || []; }
  get dashboard() { return this.dashboardList[this.dashIndex] || null; }
  get page() { return this.dashboard?.pages?.[this.pageIndex] || null; }
  get cards() { return this.page?.sections?.flatMap(s => s.cards || []) || []; }
  get selectedCard() { return this.cards.find(c => c.id === this.selectedCardId) || null; }

  setDraft(mutator) {
    if (!this.draft) return;
    mutator(this.draft);
    this.draftSource = 'draft';
    this.render();
  }

  async push() {
    if (!this.draft || !this.selectedId) return;
    this.busy = true;
    this.render();
    try {
      const r = await this.call({type:'stips_panel/push_dashboard', screen_id:this.selectedId, project:this.draft, note:'Pushed from STIPS Home Assistant editor'});
      this.message = `Revision ${r.revision} pushed to ${this.selectedId}.`;
      await this.loadScreen(this.selectedId, false);
      await this.refresh(false);
    } catch(e) { this.fail(e); }
  }

  async rollback(rev) {
    if (!confirm(`Deploy revision ${rev} again as a new revision?`)) return;
    try {
      const r = await this.call({type:'stips_panel/rollback', screen_id:this.selectedId, revision:Number(rev)});
      this.note(`Rollback queued as revision ${r.revision}.`);
      await this.refresh(false);
    } catch(e) { this.fail(e); }
  }

  async command(cmd) {
    const labels={
      reload_dashboard:'Reload dashboard', refresh_entities:'Refresh entities', reload_configuration:'Reload config',
      restart_dashboard_ui:'Restart dashboard UI', reload_metadata:'Reload metadata', restart_stips:'Restart STIPS',
      reboot_device:'Reboot device', enable_kiosk:'Enable kiosk', disable_kiosk:'Disable kiosk',
      apply_device_owner_policies:'Apply Device Owner policies'
    };
    if (cmd==='reboot_device' && !confirm('Reboot this Android panel now? STIPS should return automatically after startup.')) return;
    if (cmd==='disable_kiosk' && !confirm('Disable kiosk mode on this panel? Android system navigation may become available.')) return;
    try {
      this.busy=true; this.render();
      await this.call({type:'stips_panel/screen_command', screen_id:this.selectedId, command:cmd});
      await new Promise(resolve=>setTimeout(resolve,650));
      await this.refresh(true);
      const screen=this.screens.find(x=>x.screen_id===this.selectedId);
      const state=screen?.last_command_state||'sent';
      const detail=screen?.last_command_message||'';
      this.message=`${labels[cmd]||cmd.replaceAll('_',' ')}: ${state}${detail?` — ${detail}`:''}`;
      this.render();
    } catch(e) { this.fail(e); }
  }

  fleetIds() {
    const valid=this.fleetSelected.filter(id=>this.screens.some(x=>x.screen_id===id));
    return valid.length ? valid : (this.selectedId ? [this.selectedId] : []);
  }

  async commandData(cmd, data={}) {
    if (!this.selectedId) return;
    try {
      this.busy=true; this.render();
      await this.call({type:'stips_panel/screen_command', screen_id:this.selectedId, command:cmd, data});
      this.message=`${cmd.replaceAll('_',' ')} sent to ${this.selectedId}.`;
      this.busy=false; this.render();
    } catch(e) { this.fail(e); }
  }

  async bulkCommand(cmd, data={}) {
    const ids=this.fleetIds(); if(!ids.length)return;
    if(cmd==='reboot_device' && !confirm(`Reboot ${ids.length} selected STIPS screen(s)?`)) return;
    try {
      this.busy=true; this.render();
      const r=await this.call({type:'stips_panel/bulk_command',screen_ids:ids,command:cmd,data});
      this.message=`${cmd.replaceAll('_',' ')} sent to ${r.sent||0} screen(s).`;
      this.busy=false; this.render();
    } catch(e){this.fail(e);}
  }

  async bulkAll(cmd, data={}) {
    const ids=this.screens.map(x=>x.screen_id).filter(Boolean); if(!ids.length)return;
    if(cmd==='reboot_device' && !confirm(`Reboot all ${ids.length} STIPS screen(s)?`)) return;
    try {
      this.busy=true; this.render();
      const r=await this.call({type:'stips_panel/bulk_command',screen_ids:ids,command:cmd,data});
      this.message=`${cmd.replaceAll('_',' ')} sent to all ${r.sent||0} screen(s).`;
      this.busy=false; this.render();
    } catch(e){this.fail(e);}
  }

  selectFleetGroup(groupId) {
    const group=this.groups.find(x=>x.group_id===groupId||x.id===groupId);
    if(!group)return;
    this.fleetSelected=(group.screen_ids||[]).filter(id=>this.screens.some(s=>s.screen_id===id));
    this.message=`Selected group “${group.name||groupId}” (${this.fleetSelected.length} screen(s)).`;
    this.render();
  }

  async applyDevicePolicies() {
    const q=(s)=>this.shadowRoot.querySelector(s);
    const data={
      auto_apply:!!q('[data-policy="auto_apply"]')?.checked,
      protect_uninstall:!!q('[data-policy="protect_uninstall"]')?.checked,
      persistent_home:!!q('[data-policy="persistent_home"]')?.checked,
      disable_keyguard:!!q('[data-policy="disable_keyguard"]')?.checked,
      block_safe_boot:!!q('[data-policy="block_safe_boot"]')?.checked,
      block_add_user:!!q('[data-policy="block_add_user"]')?.checked,
      block_factory_reset:!!q('[data-policy="block_factory_reset"]')?.checked,
    };
    if(data.block_factory_reset && !confirm('Block factory reset on this fully managed panel? This restriction can make recovery harder.')) return;
    await this.commandData('set_device_owner_policies',data);
  }

  async maintenanceUnlock() {
    const el=this.shadowRoot.querySelector('[data-maintenance-minutes]');
    const minutes=Number(el?.value??5);
    await this.commandData('maintenance_unlock',{minutes,open_settings:true});
  }

  async configureWatchdog() {
    const q=(s)=>this.shadowRoot.querySelector(s);
    await this.commandData('configure_watchdog',{
      enabled:!!q('[data-watchdog-enabled]')?.checked,
      stale_socket_seconds:Number(q('[data-watchdog-stale]')?.value||180),
      restart_after_failures:Number(q('[data-watchdog-restart]')?.value||3),
      reboot_after_failures:Number(q('[data-watchdog-reboot]')?.value||8),
      daily_maintenance_enabled:!!q('[data-watchdog-daily]')?.checked,
      daily_maintenance_hour:Number(q('[data-watchdog-hour]')?.value||4),
      scheduled_reboot_days:Number(q('[data-watchdog-reboot-days]')?.value||0),
    });
  }

  async uploadApk() {
    const file=this.shadowRoot.querySelector('[data-apk-file]')?.files?.[0];
    const versionName=(this.shadowRoot.querySelector('[data-apk-version]')?.value||'').trim();
    const versionCode=Number(this.shadowRoot.querySelector('[data-apk-code]')?.value||0);
    if(!file){this.note('Choose a STIPS APK first.');return;}
    if(!versionName||versionCode<1){this.note('Enter the APK version name and numeric version code.');return;}
    try {
      this.busy=true; this.otaProgress='Starting upload…'; this.render();
      const begin=await this.call({type:'stips_panel/update_upload_begin',filename:file.name,version_name:versionName,version_code:versionCode});
      const chunkSize=Number(begin.chunk_size||393216);
      for(let offset=0;offset<file.size;offset+=chunkSize){
        const bytes=new Uint8Array(await file.slice(offset,Math.min(file.size,offset+chunkSize)).arrayBuffer());
        let binary='';
        const stride=0x8000;
        for(let i=0;i<bytes.length;i+=stride) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+stride)));
        await this.call({type:'stips_panel/update_upload_chunk',upload_id:begin.upload_id,content_base64:btoa(binary)});
        this.otaProgress=`Uploading ${Math.min(100,Math.round(Math.min(file.size,offset+chunkSize)/file.size*100))}%`;
        this.render();
      }
      const done=await this.call({type:'stips_panel/update_upload_finish',upload_id:begin.upload_id,expected_size:file.size});
      this.otaProgress='';
      this.message=`Uploaded STIPS ${done.version_name} (${Math.round(done.size_bytes/1024/1024*10)/10} MB). SHA-256 ${done.sha256.slice(0,12)}…`;
      this.busy=false;
      await this.refresh(true);
    } catch(e){this.otaProgress='';this.fail(e);}
  }

  async installUpdate(all=false) {
    const ids=all ? this.screens.map(x=>x.screen_id) : this.fleetIds();
    if(!ids.length)return;
    if(!this.latestUpdate){this.note('Upload an APK first.');return;}
    if(!confirm(`Install STIPS ${this.latestUpdate.version_name||''} on ${ids.length} screen(s)? The app will restart after a successful install.`)) return;
    try {
      this.busy=true;this.render();
      const r=await this.call({type:'stips_panel/install_update',screen_ids:ids,force:false});
      this.busy=false;this.message=`Update command sent to ${r.sent||0} screen(s).`;this.render();
    }catch(e){this.fail(e);}
  }

  async createBackup() {
    if(!this.selectedId)return;
    try { const r=await this.call({type:'stips_panel/create_backup',screen_id:this.selectedId,label:'Manual backup from Remote Manager'}); this.note(`Backup ${r.backup_id} created.`); await this.loadScreen(this.selectedId); } catch(e){this.fail(e);}
  }

  async restoreBackup(id) {
    if(!id||!this.selectedId)return;
    if(!confirm(`Restore backup ${id} to this screen? This creates a new dashboard revision and restores retained device settings.`))return;
    try { const r=await this.call({type:'stips_panel/restore_backup',screen_id:this.selectedId,backup_id:id}); this.note(`Backup restored as revision ${r.revision}.`); await this.refresh(false); } catch(e){this.fail(e);}
  }

  async cloneScreen() {
    if(!this.selectedId)return;
    const target=this.shadowRoot.querySelector('[data-clone-target]')?.value;
    if(!target)return;
    const q=(s)=>!!this.shadowRoot.querySelector(s)?.checked;
    const options={dashboard_layout:q('[data-clone="dashboard_layout"]'),theme:q('[data-clone="theme"]'),kiosk:q('[data-clone="kiosk"]'),scaling:q('[data-clone="scaling"]'),device_settings:q('[data-clone="device_settings"]'),device_policies:q('[data-clone="device_policies"]')};
    if(!confirm(`Clone selected settings from ${this.selectedId} to ${target}? Target screen identity and remote enrollment stay unchanged.`))return;
    try { const r=await this.call({type:'stips_panel/clone_screen',source_screen_id:this.selectedId,target_screen_id:target,options}); this.note(`Clone queued to ${target} as revision ${r.revision}.`); await this.refresh(true); } catch(e){this.fail(e);}
  }

  async saveFleetGroup() {
    const ids=this.fleetIds(); if(!ids.length)return;
    const name=prompt('Group name','STIPS Screens'); if(!name)return;
    const id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||`group-${Date.now()}`;
    try { await this.call({type:'stips_panel/save_group',group_id:id,name,screen_ids:ids}); this.note(`Saved group “${name}” with ${ids.length} screens.`); await this.refresh(true); } catch(e){this.fail(e);}
  }

  async applyRemoteProfile(profileId) {
    if(!profileId||!this.selectedId)return;
    try { const r=await this.call({type:'stips_panel/apply_profile',screen_id:this.selectedId,profile_id:profileId}); this.note(`Screen profile queued as revision ${r.revision}.`); await this.refresh(false); } catch(e){this.fail(e);}
  }

  async requestAndDownloadDiagnostics() {
    if(!this.selectedId)return;
    try {
      const previousCreated=this.detail?.latest_diagnostic?.created||'';
      this.busy=true;this.message='Requesting a fresh diagnostic package from screen…';this.render();
      await this.call({type:'stips_panel/screen_command',screen_id:this.selectedId,command:'upload_diagnostics',data:{}});
      let pkg=null;
      for(let i=0;i<12&&!pkg;i++){
        await new Promise(r=>setTimeout(r,750));
        try{
          const candidate=await this.call({type:'stips_panel/get_diagnostics_package',screen_id:this.selectedId});
          if(candidate?.created && candidate.created!==previousCreated) pkg=candidate;
        }catch(_){/* panel may still be packaging/uploading */}
      }
      if(!pkg) throw new Error('The panel did not upload a fresh diagnostic package yet. Check that it is online and try again.');
      const binary=atob(pkg.content_base64); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));
      const a=document.createElement('a');a.href=url;a.download=pkg.filename||'stips-diagnostics.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      this.busy=false;this.message=`Downloaded ${a.download} (${Math.round(pkg.size_bytes/1024)} KB).`;this.render();
    }catch(e){this.fail(e);}
  }

  async provisioningInfo() {
    try { const r=await this.call({type:'stips_panel/provisioning_info'}); this.message=`Device Owner provisioning: ${r.adb_device_owner_command} — ${r.managed_provisioning_note}`; this.render(); } catch(e){this.fail(e);}
  }

  async saveTemplate() {
    if (!this.draft) return;
    const name = prompt('Shared dashboard name', this.dashboard?.title || 'STIPS Dashboard');
    if (!name) return;
    const id = `shared-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || Date.now()}`;
    try {
      await this.call({type:'stips_panel/save_template', template_id:id, name, project:this.draft});
      this.note(`Saved shared dashboard “${name}”.`);
      await this.refresh(true);
    } catch(e) { this.fail(e); }
  }

  async pushTemplate(templateId) {
    try {
      const r = await this.call({type:'stips_panel/push_template', screen_id:this.selectedId, template_id:templateId});
      this.note(`Shared dashboard queued as revision ${r.revision}.`);
      await this.refresh(false);
    } catch(e) { this.fail(e); }
  }

  defaultCard(type, id) {
    return {
      id,
      type,
      title:type.replace(/([a-z])([A-Z])/g,'$1 $2'),
      entityIds:[],
      span:'OneByOne',
      layout:{width:1,height:1},
      tapAction:{kind:'tech.stips.home.core.model.CardAction.MoreInfo'},
      doubleTapAction:{kind:'tech.stips.home.core.model.CardAction.Nothing'},
      longPressAction:{kind:'tech.stips.home.core.model.CardAction.MoreInfo'},
      style:{accent:null,iconName:null,contentScale:1,showState:true,compact:false,showInlineControls:true,showIcon:true,showEntityName:true,showRoomName:false,alignment:'start',informationDensity:'auto'},
      features:{showPower:true,showBrightness:true,showColor:true,showColorTemperature:true,showCoverButtons:true,showCoverPosition:true,showCoverCurrentPosition:true,showCoverTilt:true,showClimateMode:true,showClimateSwing:true,showClimateFanMode:true,showClimateTemperatureControls:true,showClimateCurrentTemperature:true,showClimateHumidity:false,showClimatePresetMode:true,showClockSeconds:false},
      settings:{kind:'tech.stips.home.core.model.CardSettings.None'},
      visibility:null,
      customText:type==='Text'?'':null,
      securityRules:[],
      variant:'',
      graph:{hours:24,style:'line',showLegend:true},
      room:{areaId:'',lights:true,active:true,temperature:true,humidity:true,occupancy:true,media:true,quickActions:false}
    };
  }

  addCard(type, entityIds=[], title='') {
    const page = this.page;
    if (!page) return;
    if (!page.sections?.length) page.sections = [{id:`section-${Date.now()}`, title:null, cards:[]}];
    const id = `ha-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const card = this.defaultCard(type, id);
    card.entityIds = [...entityIds];
    if (title) card.title = title;
    if (type === 'Text') card.customText = '';
    if (type === 'Room' || type === 'RoomPopup') {
      card.layout=type==='RoomPopup'?{width:1.25,height:.75}:{width:2,height:2};
      card.tapAction=type==='RoomPopup'
        ? {kind:'tech.stips.home.core.model.CardAction.Navigate',target:''}
        : {kind:'tech.stips.home.core.model.CardAction.Toggle'};
      card.doubleTapAction={kind:'tech.stips.home.core.model.CardAction.Nothing'};
      card.longPressAction={kind:'tech.stips.home.core.model.CardAction.Nothing'};
      this.ensureCardSettings(card);
    }
    if (type === 'PagePopup') {
      card.layout={width:1,height:.75};
      const targetPageId=this.dashboard?.pages?.[0]?.id||'';
      card.tapAction={kind:'tech.stips.home.core.model.CardAction.Navigate',target:targetPageId};
      this.ensureCardSettings(card).targetPageId=targetPageId;
    }
    page.sections[0].cards.push(card);
    this.selectedCardId = id;
    this.draftSource = 'draft';
    this.render();
  }

  removeCard(id) {
    const page=this.page;
    if(!page) return;
    for(const s of page.sections||[]) s.cards=(s.cards||[]).filter(c=>c.id!==id);
    if(this.selectedCardId===id) this.selectedCardId='';
    this.draftSource = 'draft';
    this.render();
  }

  moveCard(dragId, targetId) {
    if (!dragId || dragId===targetId || !this.page) return;
    const all=this.cards;
    const src=all.find(c=>c.id===dragId);
    const dst=all.find(c=>c.id===targetId);
    if(!src||!dst)return;
    for(const s of this.page.sections||[]) s.cards=(s.cards||[]).filter(c=>c.id!==dragId);
    const targetSection=(this.page.sections||[]).find(s=>(s.cards||[]).some(c=>c.id===targetId));
    const i=targetSection.cards.findIndex(c=>c.id===targetId);
    targetSection.cards.splice(i,0,src);
    this.draftSource = 'draft';
    this.render();
  }

  updateCard(field, value) {
    const c=this.selectedCard;
    if(!c)return;
    if(field==='width'||field==='height') {
      c.layout ||= {width:1,height:1};
      c.layout[field]=Math.max(.1,Math.min(2,Math.round(Number(value)*10)/10));
    } else c[field]=value;
    this.draftSource = 'draft';
    this.render();
  }

  updateCardStyle(field, value) {
    const c=this.selectedCard;
    if(!c)return;
    c.style ||= {};
    if(field==='contentScale') c.style[field]=Math.max(.75,Math.min(1.75,Math.round(Number(value)*20)/20));
    else c.style[field]=value;
    this.draftSource='draft';
    this.render();
  }

  actionKind(value) {
    return `tech.stips.home.core.model.CardAction.${value}`;
  }

  updateCardAction(slot, value) {
    const c=this.selectedCard;if(!c)return;
    const defaults={Navigate:{target:''},Execute:{domain:'',service:''},OpenUrl:{url:''}};
    c[slot]={kind:this.actionKind(value),...(defaults[value]||{})};
    c.actionsCustomized=true;
    this.draftSource='draft';this.render();
  }

  updateCardActionField(slot, field, value) { const c=this.selectedCard;if(!c)return;(c[slot]||={kind:this.actionKind('Nothing')})[field]=value;c.actionsCustomized=true;this.draftSource='draft';this.render(); }

  ensureCardSettings(card=this.selectedCard) {
    if(!card)return null;
    const kinds={
      AlertControl:['AlertControl',{requireInstallerPin:false}],
      Weather:['Weather',{showTemperature:true,showCondition:true,showWeatherIcon:true,showFeelsLike:false,showTodayHighLow:true,showHumidity:true,showWind:false,showPrecipitation:false,showDailyForecast:true,showWeeklyForecast:false,forecastDays:5,temperatureUnit:'auto',iconSize:'medium',mainTemperatureSize:'medium',conditionTextSize:'medium',layout:'auto'}],
      Clock:['Clock',{use24Hour:true,showSeconds:false,showDate:true,dateFormat:'medium',showDayOfWeek:true,timeZoneId:'system',fontScale:1,alignment:'start'}],
      Date:['Clock',{use24Hour:true,showSeconds:false,showDate:true,dateFormat:'medium',showDayOfWeek:true,timeZoneId:'system',fontScale:1,alignment:'start'}],
      RgbLight:['RgbLight',{showColorWheel:true,showBrightness:true,showPresetColors:true,showRecentColors:true,favoriteColors:[],showColorTemperature:true}],
      Cover:['Cover',{controlStyle:'Slider',orientation:'Horizontal',reverseDirection:false,shortPressToggleOpenClose:false,showOpen:true,showStop:true,showClose:true,showCurrentPosition:true,showPositionSlider:true,showTilt:true,presetPositions:[0,25,50,75,100]}],
      Room:['Room',{areaId:'',visibleDomains:['light','switch','cover','climate'],entityLayout:'compact',entityOverrides:{},roomToggle:{lights:true,switches:true,closeCovers:false,turnOffClimate:false,turnOnLights:true,turnOnSwitches:true,openCovers:false,turnOnClimate:false}}],
      RoomPopup:['Room',{areaId:'',visibleDomains:['light','switch','cover','climate'],entityLayout:'compact',entityOverrides:{},roomToggle:{lights:true,switches:true,closeCovers:false,turnOffClimate:false,turnOnLights:true,turnOnSwitches:true,openCovers:false,turnOnClimate:false}}],
      PagePopup:['PagePopup',{targetPageId:'',showTitle:true,showSummary:true,roomToggle:{lights:true,switches:true,closeCovers:false,turnOffClimate:false,turnOnLights:true,turnOnSwitches:true,openCovers:false,turnOnClimate:false}}],
      Page:['Page',{targetPageId:'',showTitle:true,showSummary:true}],
      Navigation:['Page',{targetPageId:'',showTitle:true,showSummary:true}],
      NavigationButton:['Page',{targetPageId:'',showTitle:true,showSummary:true}],
      Text:['Text',{fontScale:1,alignment:'start',bold:false,maxLines:6}],
      Header:['Text',{fontScale:1,alignment:'start',bold:true,maxLines:3}],
      Connectivity:['Connectivity',{showWifi:true,showHomeAssistant:true,showInternet:false,wifiMode:'IconAndText',homeAssistantMode:'IconAndText',internetMode:'IconAndText'}],
    };
    const entry=kinds[card.type];
    if(!entry)return card.settings ||= {kind:'tech.stips.home.core.model.CardSettings.None'};
    const [name,defaults]=entry;
    const expected=`tech.stips.home.core.model.CardSettings.${name}`;
    if(!card.settings || card.settings.kind!==expected) card.settings={kind:expected,...defaults};
    else for(const [key,value] of Object.entries(defaults)) if(card.settings[key]===undefined) card.settings[key]=structuredClone(value);
    return card.settings;
  }

  updateCardSetting(field,value) { const s=this.ensureCardSettings();if(!s)return;s[field]=value;this.draftSource='draft';this.render(); }
  updateCardSettingList(field,value,numeric=false) { const values=String(value).split(',').map(x=>x.trim()).filter(Boolean);this.updateCardSetting(field,numeric?values.map(Number).filter(Number.isFinite):values); }
  updateCardFeature(field,value) { const c=this.selectedCard;if(!c)return;(c.features||={})[field]=value;this.draftSource='draft';this.render(); }
  updateCardGraph(field,value) { const c=this.selectedCard;if(!c)return;(c.graph||={hours:24,style:'line',showLegend:true})[field]=value;this.draftSource='draft';this.render(); }
  updateCardRoom(field,value) { const c=this.selectedCard;if(!c)return;(c.room||={})[field]=value;this.draftSource='draft';this.render(); }
  updateRoomCardField(field,value) { const s=this.ensureCardSettings();if(!s)return;s[field]=value;this.draftSource='draft';this.render(); }
  updatePagePopupTarget(value) {
    const c=this.selectedCard,s=this.ensureCardSettings();if(!c||!s)return;
    s.targetPageId=value;
    if(String(c.tapAction?.kind||'').endsWith('.Navigate')) c.tapAction.target=value;
    this.draftSource='draft';this.render();
  }
  updateRoomToggle(field,value) { const s=this.ensureCardSettings();if(!s)return;(s.roomToggle||={})[field]=value;this.draftSource='draft';this.render(); }
  updateRoomOverride(entityId,field,value) { const s=this.ensureCardSettings();if(!s)return;const o=(s.entityOverrides||={})[entityId]||={};o[field]=value;this.draftSource='draft';this.render(); }
  moveRoomEntity(entityId,delta) {
    const s=this.ensureCardSettings();if(!s)return;
    const supported=new Set(['light','switch','cover','climate']);
    const entities=this.entityCatalog().filter(e=>supported.has(e.domain)&&e.areaId===s.areaId).sort((a,b)=>((s.entityOverrides?.[a.id]?.order??999999)-(s.entityOverrides?.[b.id]?.order??999999))||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    const index=entities.findIndex(e=>e.id===entityId),target=index+delta;if(index<0||target<0||target>=entities.length)return;
    const [item]=entities.splice(index,1);entities.splice(target,0,item);s.entityOverrides||={};entities.forEach((e,i)=>(s.entityOverrides[e.id]||={}).order=i);this.draftSource='draft';this.render();
  }
  updateVisibility(field,value) {
    const c=this.selectedCard;if(!c)return;
    if(field==='enabled') c.visibility=value ? {entityId:'',equals:null,notEquals:null} : null;
    else { c.visibility||={entityId:'',equals:null,notEquals:null}; c.visibility[field]=value||null; }
    this.draftSource='draft';this.render();
  }
  updateSecurityRules(text) { const c=this.selectedCard;if(!c)return;c.securityRules=String(text).split(/\r?\n/).map(line=>{const [entityId,states='']=line.split('|').map(x=>x.trim());return entityId?{entityId,secureStates:states.split(',').map(x=>x.trim()).filter(Boolean)}:null;}).filter(Boolean);this.draftSource='draft';this.render(); }

  updateDashboardField(field,value) { const d=this.dashboard;if(!d)return;d[field]=value;this.draftSource='draft';this.render(); }
  updateAppearanceField(field,value) { const d=this.dashboard;if(!d)return;(d.appearance||={})[field]=value;this.draftSource='draft';this.render(); }

  ensurePanelConfig() {
    if (!this.draft) return null;
    const p=this.draft.panel ||= {};
    // The production editor always sends projects with showroom execution disabled.
    p.demoModeEnabled=false;
    p.topBar ||= {size:'Small',connectivity:'IconAndText',dashboardName:'TextOnly',customTextMode:'Hidden',customText:'',navigation:'Hidden',settings:'IconOnly',brightness:'Hidden',volume:'Hidden'};
    p.navigation ||= {items:[
      {id:'home',label:'Home',icon:'home',visible:true},
      {id:'entities',label:'Entities',icon:'sensor',visible:false},
      {id:'ha_dashboard',label:'HA',icon:'dashboard',visible:false},
      {id:'editor',label:'Edit',icon:'edit',visible:true},
      {id:'settings',label:'Settings',icon:'settings',visible:true},
    ]};
    p.floatingButton ||= {shortClickAction:'OpenMenu',sizeDp:48,positionX:0,positionY:1,showNavigation:true,openSettings:true,enterEditMode:true,exitKiosk:false};
    p.screenScale ||= {cardScale:1,textScale:1,iconScale:1,spacing:'Normal',columnsOverride:0};
    p.pinProtection ||= {settings:false,dashboardEdit:true,cardEdit:true,navigationEdit:true,exitKiosk:true,showInterfaceBars:false,floatingProtectedActions:false,installerAdvanced:true};
    p.showroom ||= {dashboardCount:2,presetProfile:'Auto',appliedPresetProfile:'',showHeader:true,headerTitle:'STIPS Smart Home',headerSubtitle:'Interactive Showroom',showHeaderTitle:true,showHeaderSubtitle:true,showPageTitle:true,showClock:true,showDate:false,showDemoBadge:true,showSettingsShortcut:false,showPageIndicator:true,hideAppNavigation:true,floatingAction:'admin',floatingLongPressOnly:true,protectAdminWithInstallerPin:true,autoResetEnabled:true,autoResetMinutes:3,attractModeEnabled:true,attractAfterSeconds:45,keepScreenAwake:true};
    p.alerts ||= {enabled:false,wakeScreen:true,showPopup:true,soundEnabled:true,selectedTone:'Siren',volume:80,rules:[]};
    // Panels older than Android 1.7.0 have no activation fields; they are Local panel with no delays.
    p.alerts.activationSource ??= 'LocalPanel';
    if (p.alerts.activationEntityId === undefined) p.alerts.activationEntityId=null;
    p.alerts.activationControlMode ??= 'FollowHomeAssistant';
    p.alerts.armingDelaySeconds ??= 0;
    p.alerts.triggerDelaySeconds ??= 0;
    if (p.floatingButton.shortClickAction == null) p.floatingButton.shortClickAction='OpenMenu';
    if (!Number.isFinite(Number(p.floatingButton.sizeDp))) p.floatingButton.sizeDp=48;
    if (!Number.isFinite(Number(p.floatingButton.positionX))) p.floatingButton.positionX=0;
    if (!Number.isFinite(Number(p.floatingButton.positionY))) p.floatingButton.positionY=1;
    return p;
  }

  updatePanelField(field, value) { const p=this.ensurePanelConfig(); if(!p)return; p[field]=value; if(field==='appThemeId')p.appThemeUpdatedAtEpochMs=Date.now(); this.draftSource='draft'; this.render(); }
  updatePinField(field,value) { const p=this.ensurePanelConfig();if(!p)return;p.pinProtection[field]=value;this.draftSource='draft';this.render(); }
  updateShowroomField(field,value) { const p=this.ensurePanelConfig();if(!p)return;p.showroom[field]=value;this.draftSource='draft';this.render(); }
  updateAlertField(field,value) { const p=this.ensurePanelConfig();if(!p)return;p.alerts[field]=value;this.draftSource='draft';this.render(); }
  updateAlertRules(text) {
    const p=this.ensurePanelConfig();if(!p)return;
    // Keep ids, enabled flags and unknown fields of rules whose entity is unchanged.
    const existing=new Map((p.alerts.rules||[]).map(rule=>[rule.entityId,rule]));
    const delay=(value)=>{ if(value==null||String(value).trim()==='')return null; const n=Math.round(Number(value)); return Number.isFinite(n)?Math.max(0,Math.min(600,n)):null; };
    p.alerts.rules=String(text).split(/\r?\n/).map((line,index)=>{
      const [entityId,triggerState,customLabel,delaySeconds]=line.split('|').map(x=>x.trim());
      if(!entityId)return null;
      const base=existing.get(entityId)||{id:`ha-alert-${index+1}-${entityId.replace(/[^a-z0-9]+/gi,'-')}`,entityId,enabled:true};
      return {...base,entityId,triggerState:triggerState||null,customLabel:customLabel||null,delaySeconds:delay(delaySeconds)};
    }).filter(Boolean);
    this.draftSource='draft';this.render();
  }
  alertActivationEntities() {
    return this.entityCatalog().filter(e=>['input_boolean','switch','binary_sensor'].includes(e.domain))
      .sort((a,b)=>(a.domain==='binary_sensor')-(b.domain==='binary_sensor')||a.name.localeCompare(b.name));
  }
  updateScreenScale(field, value) { const p=this.ensurePanelConfig(); if(!p)return; let v=value; if(['cardScale','textScale','iconScale'].includes(field)) v=Math.max(.7,Math.min(1.8,Math.round(Number(value)*20)/20)); if(field==='columnsOverride') v=Math.max(0,Math.min(8,Math.round(Number(value)))); p.screenScale[field]=v; this.draftSource='draft'; this.render(); }
  applyScalePreset(kind) { const p=this.ensurePanelConfig(); if(!p)return; p.screenScale = kind==='q7' ? {cardScale:1.25,textScale:1.20,iconScale:1.15,spacing:'Comfortable',columnsOverride:0} : {cardScale:1.00,textScale:.95,iconScale:1.00,spacing:'Compact',columnsOverride:0}; this.draftSource='draft'; this.render(); }
  updateTopBarField(field, value) { const p=this.ensurePanelConfig(); if(!p)return; p.topBar[field]=value; this.draftSource='draft'; this.render(); }
  updateFloatingField(field, value) { const p=this.ensurePanelConfig(); if(!p)return; p.floatingButton[field]=value; this.draftSource='draft'; this.render(); }
  updateFloatingNumber(field, value) {
    const p=this.ensurePanelConfig(); if(!p)return;
    let n=Number(value);
    if (field==='sizeDp') n=Math.max(32,Math.min(96,Math.round(n)));
    else n=Math.max(0,Math.min(1,n));
    p.floatingButton[field]=n; this.draftSource='draft'; this.render();
  }
  setFloatingPosition(x, y) {
    const p=this.ensurePanelConfig(); if(!p)return;
    p.floatingButton.positionX=Math.max(0,Math.min(1,Number(x)));
    p.floatingButton.positionY=Math.max(0,Math.min(1,Number(y)));
    this.draftSource='draft'; this.render();
  }
  updateNavVisibility(id, visible) {
    const p=this.ensurePanelConfig(); if(!p)return;
    let item=(p.navigation.items||[]).find(x=>x.id===id);
    if(item) item.visible=visible;
    else (p.navigation.items||=[]).push({id,label:id.replaceAll('_',' '),icon:'dashboard',visible});
    this.draftSource='draft';
    this.render();
  }

  updateRaw(text) {
    try {
      this.draft=JSON.parse(text);
      this.draftSource='draft';
      this.message='JSON applied to draft. Push when ready.';
      this.render();
    } catch(e) {
      this.message=`JSON error: ${e.message}`;
      this.render();
    }
  }

  screenProfiles() {
    return [
      {key:'Z4 4in 480x480', label:'Z4 · 4″ · 480×480', width:480, height:480, columns:2, mode:'Square480', row:118, gap:7, padX:7, padY:6},
      {key:'P726 7in 1024x600', label:'P726 · 7″ · 1024×600', width:1024, height:600, columns:4, mode:'Medium', row:146, gap:12, padX:14, padY:10},
      {key:'Q7 7in 1024x600', label:'Q7 · 7″ · 1024×600', width:1024, height:600, columns:4, mode:'Medium', row:146, gap:12, padX:14, padY:10},
      {key:'P1008 10in 1280x800', label:'P1008 · 10″ · 1280×800', width:1280, height:800, columns:6, mode:'Expanded', row:154, gap:12, padX:18, padY:10},
      {key:'Q10 Pro 10in 1280x800', label:'Q10 Pro · 10″ · 1280×800', width:1280, height:800, columns:6, mode:'Expanded', row:154, gap:12, padX:18, padY:10},
    ];
  }

  profileKeyForScreen(screen, panel) {
    const key = panel?.hardwareProfile || screen?.hardware_profile || '';
    if (this.screenProfiles().some(p => p.key === key)) return key;
    const w=Number(screen?.screen_width_px||0), h=Number(screen?.screen_height_px||0);
    if ((w===480&&h===480)||(w===480&&h===480)) return 'Z4 4in 480x480';
    if ((w===1024&&h===600)||(w===600&&h===1024)) return 'Q7 7in 1024x600';
    if ((w===1280&&h===800)||(w===800&&h===1280)) return 'Q10 Pro 10in 1280x800';
    return 'Q7 7in 1024x600';
  }

  resolvedPreviewProfile() {
    const screen=this.screens.find(x=>x.screen_id===this.selectedId);
    const panel=this.draft?.panel||{};
    const key=this.previewProfile==='actual' ? this.profileKeyForScreen(screen,panel) : this.previewProfile;
    let base=structuredClone(this.screenProfiles().find(p=>p.key===key) || this.screenProfiles()[1]);
    let orientation=this.previewOrientation;
    if (orientation==='screen') {
      const configured=(panel.autoRotate===false ? panel.orientation : (screen?.orientation || panel.orientation || 'Landscape'));
      orientation=String(configured).toLowerCase().startsWith('p') || String(configured).toLowerCase().startsWith('v') ? 'Portrait' : 'Landscape';
    }
    if (base.width===base.height) orientation='Landscape';
    if (orientation==='Portrait') {
      [base.width,base.height]=[base.height,base.width];
      if (base.key.includes('7in')) Object.assign(base,{columns:2,mode:'Compact',row:132,gap:9,padX:10,padY:10});
      if (base.key.includes('10in')) Object.assign(base,{columns:4,mode:'Medium',row:146,gap:12,padX:14,padY:10});
    }
    base.orientation=orientation;
    return base;
  }

  entityCatalog() {
    if (this._entityCatalogCache) return this._entityCatalogCache;
    const stateMap=this._hass?.states || {};
    const regMap=new Map();
    for (const e of this.entityRegistry || []) {
      const id=e.ei || e.entity_id;
      if (!id) continue;
      regMap.set(id, {
        id,
        areaId:e.ai || e.area_id || '',
        deviceId:e.di || e.device_id || '',
        registryName:e.en || e.name || e.original_name || '',
      });
    }
    const deviceArea=new Map((this.devices||[]).map(d=>[d.id,d.area_id||'']));
    const ids=new Set([...Object.keys(stateMap), ...regMap.keys()]);
    const items=[];
    for (const id of ids) {
      const state=stateMap[id];
      const reg=regMap.get(id)||{};
      const domain=id.split('.')[0]||'';
      let name=state?.attributes?.friendly_name || reg.registryName || id;
      try {
        if (state && this._hass?.formatEntityName) name=this._hass.formatEntityName(state) || name;
      } catch (_) {}
      const areaId=reg.areaId || deviceArea.get(reg.deviceId) || '';
      const area=this.areas.find(a=>a.area_id===areaId || a.id===areaId);
      items.push({id,domain,name,areaId,areaName:area?.name||'',state:state?.state||'not loaded',stateObj:state});
    }
    this._entityCatalogCache = items.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    return this._entityCatalogCache;
  }

  suggestedType(entity) {
    if (!entity) return 'EntityState';
    const d=entity.domain;
    if (d==='light') {
      const modes=entity.stateObj?.attributes?.supported_color_modes || [];
      return modes.some(x=>['hs','xy','rgb','rgbw','rgbww'].includes(x)) ? 'RgbLight' : 'Light';
    }
    return ({switch:'Switch',fan:'Fan',cover:'Cover',climate:'Climate',lock:'Lock',alarm_control_panel:'Alarm',scene:'Scene',script:'Script',automation:'Button',sensor:'Sensor',binary_sensor:'EntityState',weather:'Weather',camera:'Camera',media_player:'Media',vacuum:'Vacuum',person:'Presence',device_tracker:'Presence',button:'Button',input_boolean:'Toggle',number:'Gauge'})[d] || 'EntityState';
  }

  entityLabel(id) {
    const e=this.entityCatalog().find(x=>x.id===id);
    return e ? e.name : id;
  }

  openAddPicker() {
    this.picker={mode:'add',tab:'entities',search:'',domain:'all',area:'all',selected:[],cardType:'Auto'};
    this.render();
  }

  openEntityPicker() {
    const c=this.selectedCard;
    if(!c)return;
    this.picker={mode:'edit',tab:'entities',search:'',domain:'all',area:'all',selected:[...(c.entityIds||[])],cardType:c.type};
    this.render();
  }

  closePicker() { this.picker=null; this.render(); }

  filteredEntities() {
    if (!this.picker) return [];
    const q=(this.picker.search||'').trim().toLowerCase();
    return this.entityCatalog().filter(e => {
      if (this.picker.domain!=='all' && e.domain!==this.picker.domain) return false;
      if (this.picker.area!=='all' && e.areaId!==this.picker.area) return false;
      if (!q) return true;
      return `${e.name} ${e.id} ${e.areaName} ${e.state}`.toLowerCase().includes(q);
    });
  }

  togglePickerEntity(id) {
    if (!this.picker) return;
    const set=new Set(this.picker.selected||[]);
    if (this.picker.mode==='add') {
      if (set.has(id)) set.delete(id); else { set.clear(); set.add(id); }
    } else {
      if (set.has(id)) set.delete(id); else set.add(id);
    }
    this.picker.selected=[...set];
    this.render();
  }

  applyPicker() {
    if (!this.picker) return;
    if (this.picker.mode==='edit') {
      const c=this.selectedCard;
      if (c) c.entityIds=[...(this.picker.selected||[])];
      this.draftSource='draft';
      this.picker=null;
      this.render();
      return;
    }
    if (this.picker.tab==='builtins') {
      const type=this.picker.cardType==='Auto'?'Text':this.picker.cardType;
      this.picker=null;
      this.addCard(type,[],type==='Text'?'Text':type.replace(/([a-z])([A-Z])/g,'$1 $2'));
      return;
    }
    const id=(this.picker.selected||[])[0];
    if (!id) return;
    const entity=this.entityCatalog().find(x=>x.id===id);
    const type=this.picker.cardType==='Auto' ? this.suggestedType(entity) : this.picker.cardType;
    const title=entity?.name || id;
    this.picker=null;
    this.addCard(type,[id],title);
  }

  builtinCardTypes() {
    return ['Room','RoomPopup','PagePopup','Clock','Date','Text','PanelBrightness','PanelVolume','Connectivity','QuickActions','AlertControl','Page','NavigationButton','Header','Spacer','Divider','Image','SecuritySummary'];
  }

  pickerHtml() {
    if (!this.picker) return '';
    const entities=this.filteredEntities();
    const domains=[...new Set(this.entityCatalog().map(e=>e.domain))].sort();
    const areas=this.areas.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    const selected=new Set(this.picker.selected||[]);
    const entityRows=entities.slice(0,300).map(e=>`<button class="entity-row ${selected.has(e.id)?'selected':''}" data-picker-entity="${this.esc(e.id)}">
      <span class="entity-dot ${['unavailable','unknown','not loaded'].includes(e.state)?'off':''}"></span>
      <span class="entity-main"><b>${this.esc(e.name)}</b><small>${this.esc(e.id)}${e.areaName?` · ${this.esc(e.areaName)}`:''}</small></span>
      <span class="entity-state">${this.esc(e.state)}</span>
      <span class="suggested">${this.esc(this.suggestedType(e))}</span>
    </button>`).join('');
    const builtins=this.builtinCardTypes().map(t=>`<button class="builtin-card ${this.picker.cardType===t?'selected':''}" data-builtin="${t}"><span>${this.iconFor(t)}</span><b>${this.esc(t.replace(/([a-z])([A-Z])/g,'$1 $2'))}</b></button>`).join('');
    return `<div class="modal-backdrop" data-picker-backdrop><section class="picker-modal" role="dialog" aria-modal="true">
      <div class="picker-head"><div><span class="eyebrow">HOME ASSISTANT</span><h2>${this.picker.mode==='add'?'Add card':'Choose entities'}</h2></div><button class="icon-btn" data-picker-close>×</button></div>
      ${this.picker.mode==='add'?`<div class="picker-tabs"><button data-picker-tab="entities" class="${this.picker.tab==='entities'?'active':''}">Entities</button><button data-picker-tab="builtins" class="${this.picker.tab==='builtins'?'active':''}">Built-in</button></div>`:''}
      ${this.picker.tab==='entities'?`<div class="picker-filters">
        <label class="search grow">Search<input data-picker-search value="${this.attr(this.picker.search||'')}" placeholder="Search name, entity, area or state"></label>
        <label>Domain<select data-picker-domain><option value="all">All domains</option>${domains.map(d=>`<option value="${this.esc(d)}" ${d===this.picker.domain?'selected':''}>${this.esc(d)}</option>`).join('')}</select></label>
        <label>Area<select data-picker-area><option value="all">All areas</option>${areas.map(a=>`<option value="${this.esc(a.area_id||a.id)}" ${(a.area_id||a.id)===this.picker.area?'selected':''}>${this.esc(a.name||a.area_id||a.id)}</option>`).join('')}</select></label>
        ${this.picker.mode==='add'?`<label>Card type<select data-picker-type><option value="Auto" ${this.picker.cardType==='Auto'?'selected':''}>Auto · recommended</option>${this.cardTypes().map(t=>`<option value="${t}" ${t===this.picker.cardType?'selected':''}>${this.esc(t)}</option>`).join('')}</select></label>`:''}
      </div><div class="picker-count">${entities.length} matching entities${entities.length>300?' · showing first 300':''}</div><div class="entity-list">${entityRows||'<div class="empty big">No matching Home Assistant entities.</div>'}</div>`:`<div class="builtin-grid">${builtins}</div>`}
      <footer class="picker-actions"><span>${selected.size ? `${selected.size} selected` : (this.picker.tab==='builtins' && this.picker.cardType!=='Auto' ? this.esc(this.picker.cardType) : 'Nothing selected')}</span><div><button data-picker-close>Cancel</button><button class="primary" data-picker-apply ${this.picker.tab==='entities'&&!selected.size?'disabled':''}>${this.picker.mode==='add'?'Add card':'Use selection'}</button></div></footer>
    </section></div>`;
  }

  simulatorHtml(cards, screen, panel, top, navItems) {
    const profile=this.resolvedPreviewProfile();
    const configured=panel.screenScale||{};
    const untouched=(Number(configured.cardScale||1)===1 && Number(configured.textScale||1)===1 && Number(configured.iconScale||1)===1 && (configured.spacing||'Normal')==='Normal' && Number(configured.columnsOverride||0)===0);
    const scale=untouched && profile.width===1024 && profile.height===600
      ? {cardScale:1.25,textScale:1.20,iconScale:1.15,spacing:'Comfortable',columnsOverride:0}
      : (untouched && profile.width===480 && profile.height===480
        ? {cardScale:1,textScale:.95,iconScale:1,spacing:'Compact',columnsOverride:0}
        : {cardScale:Number(configured.cardScale||1),textScale:Number(configured.textScale||1),iconScale:Number(configured.iconScale||1),spacing:configured.spacing||'Normal',columnsOverride:Number(configured.columnsOverride||0)});
    const columns=scale.columnsOverride>=1&&scale.columnsOverride<=8?scale.columnsOverride:profile.columns;
    const compact=['Square480','Compact'].includes(profile.mode);
    const showNav=panel.showNavigation!==false;
    const showTop=(this.dashboard?.showHeader!==false) && panel.showTopBar!==false;
    const visibleNav=(navItems||[]).filter(x=>x.visible!==false);
    const floating=panel.floatingButton||{};
    const topHeight={Small:42,Large:54,ExtraLarge:66}[top.size||'Small']||42;
    const navSize=compact?62:72;
    const cardHtml=this.cards.map(card=>{
      const w=Math.max(.1,Math.min(columns,Number(card.layout?.width||1)));
      const h=Math.max(.1,Math.min(4,Number(card.layout?.height||1)));
      const widthUnits=Math.max(1,Math.min(columns*20,Math.round(w*20)));
      const extraGaps=Math.max(0,Math.ceil(h)-1);
      const cardHeight=profile.row*h + profile.gap*extraGaps;
      const heightCqw=(cardHeight/profile.width*100).toFixed(4);
      const title=card.title||card.type;
      const entity=(card.entityIds||[])[0];
      const contentScale=Math.max(.75,Math.min(1.75,Number(card.style?.contentScale||1)));
      const titleSize=(1.5*contentScale*scale.cardScale*scale.textScale).toFixed(3), subtitleSize=(.9*contentScale*scale.cardScale*scale.textScale).toFixed(3), iconSize=(2*contentScale*scale.cardScale*scale.iconScale).toFixed(3);
      return `<article class="sim-card dash-card ${card.id===this.selectedCardId?'selected':''}" draggable="true" data-card="${this.esc(card.id)}" style="--title-size:${titleSize}cqw;--subtitle-size:${subtitleSize}cqw;--icon-size:${iconSize}cqw;--icon-min:${(20*contentScale).toFixed(1)}px;grid-column:span ${widthUnits};height:${heightCqw}cqw">
        <div class="card-icon">${this.iconFor(card.type)}</div><div class="card-copy"><b>${this.esc(title)}</b><small>${this.esc(entity?this.entityLabel(entity):card.type)} · ${w}×${h}</small></div><button class="icon-btn delete" data-del="${this.esc(card.id)}">×</button>
      </article>`;
    }).join('');
    const ratio=`${profile.width}/${profile.height}`;
    const maxWidthVh=(72*profile.width/profile.height).toFixed(2);
    const railPercent=(navSize/profile.width*100).toFixed(3);
    const topCqw=(topHeight/profile.width*100).toFixed(3);
    const bottomCqw=(navSize/profile.width*100).toFixed(3);
    const padX=(profile.padX/profile.width*100).toFixed(3);
    const padY=(profile.padY/profile.width*100).toFixed(3);
    const spacingMultiplier=String(scale.spacing||'Normal').toLowerCase()==='compact'?.82:(String(scale.spacing||'Normal').toLowerCase()==='comfortable'?1.15:1);
    const gap=(profile.gap*spacingMultiplier/profile.width*100).toFixed(3);
    const navHtml=visibleNav.slice(0,7).map(x=>`<span title="${this.attr(x.label||x.id)}">${this.iconForNav(x.id)}<small>${this.esc(x.label||x.id)}</small></span>`).join('');
    const floatSize=Math.max(32,Math.min(96,Number(floating.sizeDp||48)));
    const floatSizeCqw=(floatSize/profile.width*100).toFixed(3);
    const floatX=Math.max(0,Math.min(1,Number(floating.positionX??0)));
    const floatY=Math.max(0,Math.min(1,Number(floating.positionY??1)));
    const floatVisible=panel.showFloatingUiHandle===true;
    const floatingHtml=`<button class="sim-floating ${floatVisible?'visible':'hidden'}" draggable="true" data-floating-drag title="Drag to position the ${floatVisible?'action button':'hidden recovery hotspot'}" style="--float-size:${floatSizeCqw}cqw;left:${(floatX*100).toFixed(2)}%;top:${(floatY*100).toFixed(2)}%;transform:translate(-${(floatX*100).toFixed(2)}%,-${(floatY*100).toFixed(2)}%)"><span>${floatVisible?'◆':'◌'}</span><small>${floatVisible?'Action':'Hidden'}</small></button>`;
    return `<div class="sim-meta"><b>${this.esc(profile.label)}</b><span>${profile.width}×${profile.height} · ${profile.orientation} · ${columns} logical columns · scale ${Number(scale.cardScale).toFixed(2)}×</span></div>
      <div class="device-wrap"><div class="device" style="aspect-ratio:${ratio};width:min(100%,900px,${maxWidthVh}vh)">
        <div class="device-screen ${compact?'compact':'wide'}" style="--rail:${railPercent}%;--top-h:${topCqw}cqw;--bottom-h:${bottomCqw}cqw;--pad-x:${padX}cqw;--pad-y:${padY}cqw;--gap:${gap}cqw">
          ${showNav&&!compact?`<nav class="sim-rail">${navHtml}</nav>`:''}
          <div class="sim-main">
            ${showTop?`<div class="sim-topbar"><div><b>${this.esc(this.dashboard?.title||'Dashboard')}</b><small>${this.esc(this.page?.title||'Page')}</small></div><div class="sim-top-actions">${top.connectivity!=='Hidden'?'●':''}${top.navigation!=='Hidden'?'‹ ›':''}${top.settings!=='Hidden'?'⚙':''}</div></div>`:''}
            <div class="sim-content"><section class="sim-grid" style="grid-template-columns:repeat(${columns*20},minmax(0,1fr))">${cardHtml||'<div class="empty big">No cards on this page. Use Add card.</div>'}</section></div>
            ${showNav&&compact?`<nav class="sim-bottom">${navHtml}</nav>`:''}
          </div>
          ${floatingHtml}
        </div>
      </div></div>`;
  }

  iconForNav(id) { return ({home:'⌂',entities:'◇',ha_dashboard:'▦',editor:'✎',settings:'⚙'})[id]||'◆'; }

  captureUiState() {
    if (!this.shadowRoot?.querySelector('.app')) return;
    const pick=(sel)=>this.shadowRoot.querySelector(sel)?.scrollTop || 0;
    this._uiScroll={left:pick('.left'),right:pick('.right'),workspace:pick('.workspace'),content:pick('.sim-content')};
    this._openDetails=[...this.shadowRoot.querySelectorAll('details')].map((d,i)=>d.open?i:null).filter(x=>x!==null);
  }

  restoreUiState() {
    const apply=()=>{
      const st=this._uiScroll;
      if (this._openDetails) [...this.shadowRoot.querySelectorAll('details')].forEach((d,i)=>d.open=this._openDetails.includes(i));
      if (st) {
        const set=(sel,v)=>{const el=this.shadowRoot.querySelector(sel);if(el)el.scrollTop=v||0;};
        set('.left',st.left); set('.right',st.right); set('.workspace',st.workspace); set('.sim-content',st.content);
      }
    };
    apply();
    if (typeof requestAnimationFrame==='function') requestAnimationFrame(apply);
  }

  screenOnline(screen) {
    if (!screen?.last_seen) return false;
    const seen = Date.parse(screen.last_seen);
    if (!Number.isFinite(seen)) return false;
    const timeout = Math.max(30, Number(screen.online_timeout_seconds || 150)) * 1000;
    return (Date.now() - seen) <= timeout;
  }

  lastSeenLabel(screen) {
    if (!screen?.last_seen) return 'Never';
    const seen = Date.parse(screen.last_seen);
    if (!Number.isFinite(seen)) return String(screen.last_seen).replace('T',' ').slice(0,16);
    const seconds = Math.max(0, Math.floor((Date.now() - seen) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  durationLabel(seconds) {
    const n=Math.max(0,Number(seconds||0));
    const d=Math.floor(n/86400), h=Math.floor((n%86400)/3600), m=Math.floor((n%3600)/60);
    return d?`${d}d ${String(h).padStart(2,'0')}h`:(h?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m`);
  }

  epochLabel(ms) {
    const n=Number(ms||0); if(!n)return '—';
    const d=new Date(n); return Number.isFinite(d.getTime())?d.toLocaleString():'—';
  }

  render() {
    this.captureUiState();
    const screen=this.screens.find(x=>x.screen_id===this.selectedId);
    const d=this.dashboard, p=this.page, c=this.selectedCard;
    const panel=this.draft?this.ensurePanelConfig():{};
    const top=panel.topBar||{};
    const showroom=panel.showroom||{};
    const pin=panel.pinProtection||{};
    const alerts=panel.alerts||{};
    const appearance=d?.appearance||{};
    const navItems=panel.navigation?.items||[];
    const navVisible=(id, fallback=true)=>navItems.find(x=>x.id===id)?.visible ?? fallback;
    const checked=(v)=>v?'checked':'';
    const topModes=['Hidden','IconOnly','TextOnly','IconAndText'];
    const topModeOptions=(value)=>topModes.map(x=>`<option value="${x}" ${x===(value||'Hidden')?'selected':''}>${x.replace('IconOnly','Icon').replace('TextOnly','Text').replace('IconAndText','Icon + text')}</option>`).join('');
    const deploymentState=(screen?.state||'unknown').replaceAll('_',' ');
    const online=this.screenOnline(screen);
    const connectionState=online?'Online':'Offline';
    const revs=this.detail?.revisions||[];
    const dashOpts=this.dashboardList.map((x,i)=>`<option value="${i}" ${i===this.dashIndex?'selected':''}>${this.esc(x.title)}</option>`).join('');
    const pageOpts=(d?.pages||[]).map((x,i)=>`<option value="${i}" ${i===this.pageIndex?'selected':''}>${this.esc(x.title)}</option>`).join('');
    const revisionHtml=revs.slice(0,8).map(r=>`<button class="revision" data-rollback="${r.revision}"><b>v${r.revision}</b><span>${this.esc(r.note||'Dashboard revision')}</span><small>${this.esc((r.created||'').replace('T',' ').slice(0,19))}</small></button>`).join('') || '<div class="empty">No deployed revisions yet.</div>';
    const templateHtml=this.templates.map(t=>`<button class="template" data-template="${this.esc(t.template_id)}"><span>◫</span><b>${this.esc(t.name)}</b><small>Push to selected screen</small></button>`).join('') || '<div class="empty">No shared dashboards yet.</div>';
    const jsonText=this.draft?this.esc(JSON.stringify(this.draft,null,2)):'';
    const profile=this.resolvedPreviewProfile();
    const screenSummary=screen?`${screen.kiosk?'Kiosk':'Normal'} · ${screen.device_owner?'Device Owner':'Standard app'} · ${screen.lock_task_active?'Lock Task active':(screen.lock_task_permitted?'Lock Task ready':'Lock Task unavailable')} · Top bar ${screen.show_top_bar===false?'off':'on'} · Navigator ${screen.show_navigation===false?'off':'on'} · Action ${screen.show_floating_button===false?'hidden':'shown'} · ${screen.floating_button_size_dp||48}dp`:'';
    const entityChips=c?(c.entityIds||[]).map(id=>`<span class="entity-chip" title="${this.attr(id)}">${this.esc(this.entityLabel(id))}<small>${this.esc(id)}</small></span>`).join(''):'';
    const fs=this.fleetSummary||{};
    const scale=panel.screenScale||{cardScale:1,textScale:1,iconScale:1,spacing:'Normal',columnsOverride:0};
    const fleetOptions=this.screens.map(s=>`<option value="${this.attr(s.screen_id)}" ${this.fleetSelected.includes(s.screen_id)?'selected':''}>${this.esc(s.screen_name||s.screen_id)} · ${this.screenOnline(s)?'Online':'Offline'} · ${this.esc(s.app_version||'—')}</option>`).join('');
    const backups=this.detail?.backups||[];
    const backupHtml=backups.slice(0,10).map(b=>`<button class="revision" data-restore-backup="${this.attr(b.backup_id)}"><b>↶</b><span>${this.esc(b.label||'Backup')}</span><small>${this.esc((b.created||'').replace('T',' ').slice(0,19))}</small></button>`).join('')||'<div class="empty">No backups yet.</div>';
    const cloneTargets=this.screens.filter(s=>s.screen_id!==this.selectedId).map(s=>`<option value="${this.attr(s.screen_id)}">${this.esc(s.screen_name||s.screen_id)}</option>`).join('');
    const profileOptions=this.profiles.map(x=>`<option value="${this.attr(x.profile_id)}">${this.esc(x.name)}</option>`).join('');
    const groupsHtml=this.groups.map(g=>`<button class="group-chip" data-group="${this.attr(g.group_id||g.id||'')}">${this.esc(g.name)} · ${(g.screen_ids||[]).length}</button>`).join('')||'<span class="hint">No fleet groups yet.</span>';
    const cardSettings=c?this.ensureCardSettings(c):{};
    const roomEntities=['Room','RoomPopup'].includes(c?.type) ? this.entityCatalog().filter(e=>['light','switch','cover','climate'].includes(e.domain)&&e.areaId===cardSettings.areaId).sort((a,b)=>((cardSettings.entityOverrides?.[a.id]?.order??999999)-(cardSettings.entityOverrides?.[b.id]?.order??999999))||a.name.localeCompare(b.name)||a.id.localeCompare(b.id)) : [];
    const cardActionName=(action)=>String(action?.kind||'').split('.').pop()||'Nothing';
    const popupCard=['RoomPopup','PagePopup'].includes(c?.type);
    const actionOptions=(action)=>['MoreInfo','Toggle','Navigate','Execute','OpenUrl','Nothing'].map(x=>`<option value="${x}" ${cardActionName(action)===x?'selected':''}>${popupCard&&x==='Navigate'?'Open popup':x.replace('MoreInfo','More info').replace('OpenUrl','Open URL')}</option>`).join('');
    const actionFields=(slot,action)=>cardActionName(action)==='Navigate'&&popupCard?`<p class="hint">${c.type==='RoomPopup'?'Opens this room’s live controls.':'Opens the page selected under Page popup.'}</p>`:cardActionName(action)==='Navigate'?`<label>Navigation target<select data-card-action-field="${slot}:target"><option value="">Choose page</option>${(this.dashboard?.pages||[]).map(page=>`<option value="${this.attr(page.id)}" ${page.id===action?.target?'selected':''}>${this.esc(page.title||page.id)}</option>`).join('')}</select></label>`:cardActionName(action)==='Execute'?`<div class="two"><label>Service domain<input data-card-action-field="${slot}:domain" value="${this.attr(action?.domain||'')}"></label><label>Service<input data-card-action-field="${slot}:service" value="${this.attr(action?.service||'')}"></label></div>`:cardActionName(action)==='OpenUrl'?`<label>URL<input data-card-action-field="${slot}:url" value="${this.attr(action?.url||'')}"></label>`:'';
    const alertRules=(alerts.rules||[]).map(rule=>[rule.entityId,rule.triggerState||'',rule.customLabel||'',rule.delaySeconds??''].join('|').replace(/\|+$/,'')).join('\n');
    const alertHa=alerts.activationSource==='HomeAssistantEntity';
    const alertEntities=this.draft?this.alertActivationEntities():[];
    const alertEntityOptions=alertEntities.map(e=>`<option value="${this.attr(e.id)}">${this.esc(e.name)}${e.domain==='binary_sensor'?' (read-only)':''}</option>`).join('');
    const alertReadOnly=String(alerts.activationEntityId||'').startsWith('binary_sensor.');
    const delayOptions=(value)=>[0,5,10,15,20,30,45,60,90,120,180,300,Number(value||0)].filter((x,i,a)=>a.indexOf(x)===i).sort((a,b)=>a-b).map(x=>`<option value="${x}" ${x===Number(value||0)?'selected':''}>${x===0?'Off':x%60===0?`${x/60} min`:`${x} s`}</option>`).join('');

    this.shadowRoot.innerHTML=`
      <style>${this.css()}</style>
      <div class="app">
        <header><div><span class="eyebrow">STIPS PANEL</span><h1>Fleet Manager + Dashboard Studio</h1><p>Manage updates, health, Device Owner policy and configuration across every STIPS wall panel.</p></div>
          <div class="header-actions"><button data-refresh ${this.busy?'disabled':''}>↻ Refresh status</button><button data-sync ${!this.selectedId||this.busy?'disabled':''}>⇩ Sync from screen</button><button class="primary" data-push ${!this.draft||this.busy?'disabled':''}>Push to screen</button></div></header>
        ${this.message?`<div class="message">${this.esc(this.message)}</div>`:''}
        <section class="fleet panel">
          <div class="fleet-head"><div><span class="eyebrow">FLEET</span><b>${fs.screens||0} screens · target ${this.esc(fs.latest_version||this.latestUpdate?.version_name||'not set')}</b></div><div class="fleet-groups">${groupsHtml}</div></div>
          <div class="fleet-stats"><div><span>Screens</span><b>${fs.screens||0}</b></div><div><span>Online</span><b>${fs.online||0}</b></div><div><span>Device Owner</span><b>${fs.device_owner||0}/${fs.screens||0}</b></div><div><span>Current version</span><b>${fs.current_version||0}/${fs.screens||0}</b></div><div><span>Updates pending</span><b>${fs.updates_pending||0}</b></div><div><span>Problems</span><b>${fs.problems||0}</b></div></div>
          <div class="fleet-controls">
            <label>Fleet selection<select multiple size="${Math.min(5,Math.max(2,this.screens.length))}" data-fleet-select>${fleetOptions}</select><small>Nothing selected = current screen.</small></label>
            <div class="fleet-buttons"><button data-bulk="refresh_entities">Refresh selected</button><button data-bulk="reload_metadata">Reload metadata selected</button><button data-bulk="restart_stips">Restart selected</button><button class="danger" data-bulk="reboot_device">Reboot selected</button><button data-bulk-all="refresh_entities">Refresh all</button><button data-bulk-all="reload_metadata">Reload metadata all</button><button data-save-group>Save selection as group</button></div>
          </div>
          <details class="ota"><summary>APK update / OTA</summary><div class="ota-grid">
            <label>APK<input type="file" accept=".apk,application/vnd.android.package-archive" data-apk-file></label>
            <label>Version name<input data-apk-version value="${this.attr(this.latestUpdate?.version_name||'1.3.28')}" placeholder="1.3.28"></label>
            <label>Version code<input type="number" min="1" data-apk-code value="${Number(this.latestUpdate?.version_code||42)}"></label>
            <div class="ota-actions"><button data-upload-apk>Upload APK to HA</button><button class="primary" data-install-update ${!this.latestUpdate?'disabled':''}>Install on selected</button><button class="primary" data-update-all ${!this.latestUpdate?'disabled':''}>Update all screens</button></div>
          </div>${this.latestUpdate?`<div class="update-meta"><b>Available ${this.esc(this.latestUpdate.version_name||'')}</b><span>${Math.round(Number(this.latestUpdate.size_bytes||0)/1024/1024*10)/10} MB · SHA-256 ${this.esc((this.latestUpdate.sha256||'').slice(0,16))}… · uploaded ${this.esc((this.latestUpdate.created||'').replace('T',' ').slice(0,19))}</span></div>`:'<p class="hint">Upload the signed STIPS APK once, then install it on one, selected, or all managed screens.</p>'}${this.otaProgress?`<div class="progress-note">${this.esc(this.otaProgress)}</div>`:''}</details>
        </section>
        <div class="layout">
          <aside class="left panel">
            <h3>Screens</h3>
            <div class="screens">${this.screens.map(s=>`<button class="screen ${s.screen_id===this.selectedId?'active':''}" data-screen="${this.esc(s.screen_id)}"><span class="dot ${this.screenOnline(s)?'on':'off'}" title="${this.screenOnline(s)?'Online':'Offline'} · ${this.attr(this.lastSeenLabel(s))}"></span><span><b>${this.esc(s.screen_name||s.screen_id)}</b><small>${this.esc(s.screen_id)}</small></span><em>${this.screenOnline(s)?'Online':'Offline'}</em></button>`).join('')||'<div class="empty">Enable Remote panel management on a STIPS screen.</div>'}</div>
            ${screen?`<div class="status"><div><span>Connection</span><b class="presence ${online?'online':'offline'}">${connectionState}</b></div><div><span>Deployment</span><b>${this.esc(deploymentState)}</b></div><div><span>Installed</span><b>v${screen.installed_revision||0}</b></div><div><span>Desired</span><b>v${screen.desired_revision||0}</b></div><div><span>Device Owner</span><b>${screen.device_owner?'Active ✓':'Inactive'}</b></div><div><span>Kiosk lock</span><b>${screen.lock_task_active?'Locked':(screen.lock_task_permitted?'Ready':'No')}</b></div><div><span>Uninstall</span><b>${screen.uninstall_blocked?'Protected':'Allowed'}</b></div><div><span>Home app</span><b>${screen.default_launcher?'STIPS':'Other'}</b></div><div><span>Network</span><b>${screen.wifi_connected?'Wi-Fi/LAN':'No Wi-Fi'}${screen.internet_validated?' + Internet':''}</b></div><div><span>Battery</span><b>${Number(screen.battery_level)>=0?`${screen.battery_level}%${screen.battery_charging?' ⚡':''}`:'—'}</b></div><div><span>Draft source</span><b>${this.esc(this.draftSource||'—')}</b></div><div><span>App</span><b>${this.esc(screen.app_version?`v${screen.app_version}`:'—')} · Android ${this.esc(screen.android_version||'—')}</b></div><div><span>Device</span><b>${this.esc(screen.device_model||'—')}</b></div><div><span>Display</span><b>${screen.screen_width_px&&screen.screen_height_px?`${screen.screen_width_px}×${screen.screen_height_px}`:'—'}</b></div><div><span>Performance</span><b>${this.esc(screen.effective_performance_mode||screen.performance_mode||'—')}</b></div><div><span>Last seen</span><b>${this.esc(this.lastSeenLabel(screen))}</b></div></div><div class="applied"><b>Applied screen</b><span>${this.esc(screenSummary)}</span>${screen.last_command?`<span class="last-command">Last command: ${this.esc(screen.last_command.replaceAll('_',' '))} · ${this.esc(screen.last_command_state||'sent')}${screen.last_command_message?` · ${this.esc(screen.last_command_message)}`:''}</span>`:''}</div>`:''}
            <h3>Shared dashboards</h3><div class="templates">${templateHtml}</div><button class="wide" data-save-template ${!this.draft?'disabled':''}>Save draft as shared</button>
            <h3>Remote actions</h3><div class="commands">
              <button data-command="reload_dashboard" ${!online?'disabled':''}>Reload dashboard</button>
              <button data-command="reload_metadata" ${!online?'disabled':''}>Reload metadata</button>
              <button data-command="refresh_entities" ${!online?'disabled':''}>Refresh entities</button>
              <button data-command="clear_stale_caches" ${!online?'disabled':''}>Clear stale caches</button>
              <button data-command="restart_stips" ${!online?'disabled':''}>Restart STIPS</button>
              <button data-command="${screen?.kiosk?'disable_kiosk':'enable_kiosk'}" ${!online?'disabled':''}>${screen?.kiosk?'Disable kiosk':'Enable kiosk'}</button>
              <button class="danger" data-command="reboot_device" ${!online||!screen?.device_owner?'disabled':''}>Reboot device</button>
            </div>
            ${screen?`<details><summary>Diagnostics</summary><div class="diagnostics-grid">
              <span>STIPS</span><b>${this.esc(screen.app_version||'—')}</b><span>Android</span><b>${this.esc(screen.android_version||'—')}</b>
              <span>Device Owner</span><b>${screen.device_owner?'Active ✓':'Inactive'}</b><span>Kiosk</span><b>${screen.lock_task_active?'Locked':'Unlocked'}</b>
              <span>HA Socket</span><b>${screen.ha_socket_connected?'Connected':'Disconnected'}</b><span>Metadata</span><b>${screen.metadata_loaded?'Loaded':'Not loaded'}</b>
              <span>Last HA RX</span><b>${this.epochLabel(screen.last_ha_rx_epoch_ms)}</b><span>Wi-Fi</span><b>${screen.wifi_rssi_dbm?`${screen.wifi_rssi_dbm} dBm`:'—'}</b>
              <span>IP</span><b>${this.esc(screen.ip_address||'—')}</b><span>Uptime</span><b>${this.durationLabel(screen.uptime_seconds)}</b>
              <span>App uptime</span><b>${this.durationLabel(screen.app_uptime_seconds)}</b><span>Memory</span><b>${screen.memory_used_mb??'—'} MB / ${screen.memory_available_mb??'—'} MB free</b>
              <span>Storage</span><b>${screen.storage_free_mb??'—'} / ${screen.storage_total_mb??'—'} MB</b><span>Battery</span><b>${screen.battery_level??'—'}% ${screen.battery_charging?' / AC':''}</b>
              <span>Temperature</span><b>${Number(screen.temperature_c)>-100?`${screen.temperature_c}°C`:'—'}</b><span>Display</span><b>${screen.screen_interactive?'On':'Off'} · ${screen.system_brightness??'—'} · ${this.esc(screen.screen_orientation||'—')}</b>
              <span>Screen timeout</span><b>${screen.screen_timeout_minutes??'—'} min</b><span>System update</span><b>${this.esc(screen.system_update_policy||'—')}</b>
              <span>Health</span><b>${this.esc(screen.health_state||'—')} ${screen.health_attempt?`(${screen.health_attempt})`:''}</b><span>Last failure</span><b>${this.esc(screen.last_failure||'—')}</b>
              <span>Reconnects</span><b>${screen.reconnect_count||0}</b><span>Metadata reloads</span><b>${screen.metadata_reload_count||0}</b>
              <span>App restarts</span><b>${screen.app_restart_count||0}</b><span>Device reboots</span><b>${screen.device_reboot_count||0}</b>
              <span>Last restart</span><b>${this.esc(screen.last_restart_reason||'—')} · ${this.epochLabel(screen.last_restart_at_epoch_ms)}</b><span>Update</span><b>${this.esc(screen.update_phase||'idle')} ${screen.update_progress||0}%</b>
            </div><button class="wide" data-diagnostics ${!online?'disabled':''}>Download diagnostic package</button></details>
            <details><summary>Device Management</summary><div class="panel-settings">
              <label class="toggleline"><input type="checkbox" data-policy="auto_apply" ${checked(screen.policy_auto_apply)}> Auto-apply managed policies</label>
              <label class="toggleline"><input type="checkbox" data-policy="protect_uninstall" ${checked(screen.uninstall_blocked)}> Prevent uninstall</label>
              <label class="toggleline"><input type="checkbox" data-policy="persistent_home" ${checked(screen.default_launcher)}> STIPS as Home</label>
              <label class="toggleline"><input type="checkbox" data-policy="disable_keyguard" ${checked(screen.policy_disable_keyguard)}> Disable keyguard</label>
              <label class="toggleline"><input type="checkbox" data-policy="block_safe_boot" ${checked(screen.block_safe_boot)}> Block safe boot</label>
              <label class="toggleline"><input type="checkbox" data-policy="block_add_user" ${checked(screen.block_add_user)}> Block add users</label>
              <div class="advanced-policy"><b>Advanced</b><label class="toggleline"><input type="checkbox" data-policy="block_factory_reset" ${checked(screen.block_factory_reset)}> Block factory reset</label></div>
              <button data-apply-policies ${!screen.device_owner?'disabled':''}>Apply Policies</button>
              <label>Maintenance unlock<select data-maintenance-minutes><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="0">Until manually locked</option></select></label>
              <div class="two"><button data-maintenance-unlock ${!screen.device_owner?'disabled':''}>Unlock + Settings</button><button data-maintenance-lock>Restore kiosk now</button></div>
              <label>Android system updates<select data-system-update><option value="system_default" ${screen.system_update_policy==='system_default'?'selected':''}>System default</option><option value="automatic" ${screen.system_update_policy==='automatic'?'selected':''}>Automatic</option><option value="overnight" ${screen.system_update_policy==='overnight'?'selected':''}>Install overnight</option><option value="postpone" ${screen.system_update_policy==='postpone'?'selected':''}>Postpone</option></select></label>
              <button data-apply-system-update ${!screen.device_owner?'disabled':''}>Apply system-update policy</button>
              <button data-bugreport ${!screen.device_owner?'disabled':''}>Request Android bug report</button>
              <small class="hint">Bug report state: ${this.esc(screen.bugreport_state||'none')}</small>
            </div></details>
            <details><summary>Watchdog & scheduled maintenance</summary><div class="panel-settings">
              <label class="toggleline"><input type="checkbox" data-watchdog-enabled ${checked(screen.watchdog_enabled!==false)}> Health watchdog enabled</label>
              <label>Stale HA socket after (seconds)<input type="number" min="60" max="1800" value="${screen.watchdog_stale_socket_seconds||180}" data-watchdog-stale></label>
              <div class="two"><label>Restart after failures<input type="number" min="2" max="20" value="${screen.watchdog_restart_after_failures||3}" data-watchdog-restart></label><label>Reboot after failures<input type="number" min="4" max="50" value="${screen.watchdog_reboot_after_failures||8}" data-watchdog-reboot></label></div>
              <label class="toggleline"><input type="checkbox" data-watchdog-daily ${checked(screen.daily_maintenance_enabled!==false)}> Daily health maintenance</label>
              <div class="two"><label>Hour<input type="number" min="0" max="23" value="${screen.daily_maintenance_hour??4}" data-watchdog-hour></label><label>Scheduled reboot days<input type="number" min="0" max="90" value="${screen.scheduled_reboot_days||0}" data-watchdog-reboot-days></label></div>
              <button data-watchdog-apply>Apply watchdog settings</button><p class="hint">Scheduled reboot 0 = disabled. HA outages are not allowed to trigger reboot escalation.</p>
            </div></details>
            <details><summary>Backup / restore / clone</summary><div class="panel-settings"><button data-create-backup>Create configuration backup</button><div class="revisions">${backupHtml}</div>
              <label>Clone to<select data-clone-target><option value="">Choose target…</option>${cloneTargets}</select></label>
              <div class="subgrid"><label class="toggleline"><input type="checkbox" data-clone="dashboard_layout" checked> Dashboard</label><label class="toggleline"><input type="checkbox" data-clone="theme" checked> Theme</label><label class="toggleline"><input type="checkbox" data-clone="kiosk" checked> Kiosk</label><label class="toggleline"><input type="checkbox" data-clone="scaling" checked> Scaling</label><label class="toggleline"><input type="checkbox" data-clone="device_settings" checked> Display/device</label><label class="toggleline"><input type="checkbox" data-clone="device_policies" checked> Policies</label></div><button data-clone-screen ${!cloneTargets?'disabled':''}>Clone selected settings</button>
              <label>Managed screen profile<select data-remote-profile><option value="">Choose profile…</option>${profileOptions}</select></label><button data-apply-profile>Apply profile to screen</button>
              <button data-provisioning>Provisioning / Device Owner info</button>
            </div></details>`:''}
          </aside>

          <main class="workspace panel">
            <div class="toolbar">
              <label>Workspace<select data-project-space><option value="dashboards" selected>Live dashboards</option></select></label>
              <label>Dashboard<select data-dashboard>${dashOpts}</select></label><label>Page<select data-page>${pageOpts}</select></label>
              <label>Screen layout<select data-preview-profile><option value="actual" ${this.previewProfile==='actual'?'selected':''}>Selected screen / Auto</option>${this.screenProfiles().map(x=>`<option value="${this.esc(x.key)}" ${x.key===this.previewProfile?'selected':''}>${this.esc(x.label)}</option>`).join('')}</select></label>
              <label>Layout orientation<select data-preview-orientation><option value="screen" ${this.previewOrientation==='screen'?'selected':''}>Screen setting</option><option value="Landscape" ${this.previewOrientation==='Landscape'?'selected':''}>Horizontal</option><option value="Portrait" ${this.previewOrientation==='Portrait'?'selected':''}>Vertical</option></select></label>
              <span class="grow"></span><button data-add>＋ Add card</button><button data-save-template>Save shared</button>
            </div>
            ${this.draft?`<div class="preview-head"><div><b>${this.esc(d?.title||'Dashboard')}</b><span>${this.esc(p?.title||'Page')}</span></div><span>${this.esc(profile.label)} · drag cards to reorder</span></div>${this.simulatorHtml(this.cards,screen,panel,top,navItems)}`:'<div class="empty big">Waiting for a screen snapshot.</div>'}
          </main>

          <aside class="right panel">
            <div class="tabs"><button class="active">Card</button><span>${c?'Selected':'Nothing selected'}</span></div>
            ${c?`<section class="card-inspector">
              <div class="selected-preview"><span class="card-icon">${this.iconFor(c.type)}</span><div><b>${this.esc(c.title||c.type)}</b><small>${this.esc(c.type)} · ${c.layout?.width||1}×${c.layout?.height||1}</small></div></div>
              <div class="inspector">
                <label>Card title<input data-field="title" value="${this.attr(c.title||'')}"></label>
                <label>Card type<select data-field="type">${this.cardTypes().map(t=>`<option ${t===c.type?'selected':''}>${t}</option>`).join('')}</select></label>
                <div><label class="field-label">Home Assistant entities</label><div class="entity-chips">${entityChips||'<span class="hint">No entity selected.</span>'}</div><div class="entity-actions"><button data-edit-entities>Choose from Home Assistant</button>${(c.entityIds||[]).length?'<button data-clear-entities>Clear</button>':''}</div></div>
                <div class="two"><label>Width<input type="number" min=".1" max="2" step=".1" data-field="width" value="${c.layout?.width||1}"></label><label>Height<input type="number" min=".1" max="2" step=".1" data-field="height" value="${c.layout?.height||1}"></label></div>
                 <label>Content zoom <b>${Number(c.style?.contentScale||1).toFixed(2)}×</b><input type="range" min=".75" max="1.75" step=".05" data-style-number="contentScale" value="${c.style?.contentScale||1}"></label>
                 <p class="hint">1.00× keeps the original card text/icons. Try 1.15–1.35× on larger 7–10 inch panels. The preview uses the selected physical panel profile.</p>
                 <details><summary>Presentation</summary><div class="panel-settings">
                   <div class="subgrid">${[['showEntityName','Name'],['showRoomName','Room'],['showState','State'],['showIcon','Icon'],['compact','Compact'],['showInlineControls','Inline controls']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-style-bool="${f}" ${checked(c.style?.[f] ?? !['showRoomName','compact'].includes(f))}> ${l}</label>`).join('')}</div>
                   <label>Alignment<select data-style-select="alignment">${['start','center','end'].map(x=>`<option value="${x}" ${x===(c.style?.alignment||'start')?'selected':''}>${x}</option>`).join('')}</select></label>
                   <label>Information density<select data-style-select="informationDensity">${['auto','compact','comfortable'].map(x=>`<option value="${x}" ${x===(c.style?.informationDensity||'auto')?'selected':''}>${x}</option>`).join('')}</select></label>
                   <div class="two"><label>Accent<input data-style-text="accent" value="${this.attr(c.style?.accent||'')}" placeholder="#6750A4"></label><label>Icon name<input data-style-text="iconName" value="${this.attr(c.style?.iconName||'')}" placeholder="automatic"></label></div>
                   <label>Variant<input data-field="variant" value="${this.attr(c.variant||'')}" placeholder="Default"></label>
                 </div></details>
                 <details><summary>Actions & visibility</summary><div class="panel-settings">
                   <label>Tap<select data-card-action="tapAction">${actionOptions(c.tapAction)}</select></label>${actionFields('tapAction',c.tapAction)}<label>Double tap<select data-card-action="doubleTapAction">${actionOptions(c.doubleTapAction)}</select></label>${actionFields('doubleTapAction',c.doubleTapAction)}<label>Long press<select data-card-action="longPressAction">${actionOptions(c.longPressAction)}</select></label>${actionFields('longPressAction',c.longPressAction)}
                   <label class="toggleline"><input type="checkbox" data-visibility="enabled" ${checked(!!c.visibility)}> Conditional visibility</label>
                   ${c.visibility?`<label>Condition entity<input data-visibility="entityId" value="${this.attr(c.visibility.entityId||'')}"></label><div class="two"><label>Equals<input data-visibility="equals" value="${this.attr(c.visibility.equals||'')}"></label><label>Not equals<input data-visibility="notEquals" value="${this.attr(c.visibility.notEquals||'')}"></label></div>`:''}
                 </div></details>
                 <details><summary>Entity controls</summary><div class="panel-settings"><div class="subgrid">${[['showPower','Power'],['showBrightness','Brightness'],['showColor','Color'],['showColorTemperature','Color temperature'],['showCoverButtons','Cover buttons'],['showCoverPosition','Cover position'],['showCoverCurrentPosition','Current cover position'],['showCoverTilt','Cover tilt'],['showClimateMode','HVAC mode'],['showClimateTemperatureControls','Target temperature'],['showClimateCurrentTemperature','Current temperature'],['showClimateFanMode','Fan mode'],['showClimateSwing','Swing'],['showClimatePresetMode','Preset'],['showClimateHumidity','Humidity'],['showClockSeconds','Clock seconds']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-feature-bool="${f}" ${checked(c.features?.[f] ?? !['showClimateHumidity','showClockSeconds'].includes(f))}> ${l}</label>`).join('')}</div></div></details>
                 ${['Graph','History'].includes(c.type)?`<details open><summary>Graph / history</summary><div class="panel-settings"><label>Period<select data-graph-number="hours">${[1,6,12,24,168,720].map(x=>`<option value="${x}" ${Number(c.graph?.hours||24)===x?'selected':''}>${x<24?`${x} hours`:x===24?'1 day':x===168?'7 days':'30 days'}</option>`).join('')}</select></label><label>Style<select data-graph-select="style">${['line','area','bar'].map(x=>`<option value="${x}" ${x===(c.graph?.style||'line')?'selected':''}>${x}</option>`).join('')}</select></label><label class="toggleline"><input type="checkbox" data-graph-bool="showLegend" ${checked(c.graph?.showLegend!==false)}> Legend</label></div></details>`:''}
                 ${c.type==='Area'?`<details open><summary>Room summary</summary><div class="panel-settings"><label>Area ID<input data-room-text="areaId" value="${this.attr(c.room?.areaId||'')}"></label><div class="subgrid">${[['lights','Lights'],['active','Active devices'],['temperature','Temperature'],['humidity','Humidity'],['occupancy','Occupancy'],['media','Media'],['quickActions','Quick actions']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-room-bool="${f}" ${checked(c.room?.[f] ?? f!=='quickActions')}> ${l}</label>`).join('')}</div></div></details>`:''}
                  ${['Room','RoomPopup'].includes(c.type)?`<details open><summary>${c.type==='RoomPopup'?'Room Popup Card':'Room Card'}</summary><div class="panel-settings">
                    ${c.type==='RoomPopup'?'<p class="hint">Open popup displays this Home Assistant room’s live controls in a larger modal. It does not open a dashboard page.</p>':''}
                   <label>Home Assistant area<select data-room-card-area><option value="">Choose area</option>${this.areas.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(a=>{const id=a.area_id||a.id;return `<option value="${this.attr(id)}" ${id===cardSettings.areaId?'selected':''}>${this.esc(a.name||id)}</option>`}).join('')}</select></label>
                   <label>Show entities<select data-room-domains>${[['light,switch,cover,climate','All'],['light','Lights'],['switch','Switches'],['light,switch','Lights & Switches'],['cover','Shutters'],['climate','AC / Climate']].map(([v,l])=>`<option value="${v}" ${v.split(',').every(x=>(cardSettings.visibleDomains||[]).includes(x))&&(cardSettings.visibleDomains||[]).length===v.split(',').length?'selected':''}>${l}</option>`).join('')}</select></label>
                   <label>Light & switch layout<select data-room-layout><option value="compact" ${cardSettings.entityLayout!=='full'?'selected':''}>Compact · 2 per row</option><option value="full" ${cardSettings.entityLayout==='full'?'selected':''}>Full row · power button</option></select></label>
                    <b>Room OFF behavior</b><div class="subgrid">${[['lights','Turn off lights'],['switches','Turn off switches'],['closeCovers','Close shutters'],['turnOffClimate','Turn off AC']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-room-toggle="${f}" ${checked(cardSettings.roomToggle?.[f] ?? ['lights','switches'].includes(f))}> ${l}</label>`).join('')}</div>
                    <b>Room ON behavior</b><div class="subgrid">${[['turnOnLights','Turn on lights'],['turnOnSwitches','Turn on switches'],['openCovers','Open shutters'],['turnOnClimate','Turn on AC']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-room-toggle="${f}" ${checked(cardSettings.roomToggle?.[f] ?? ['turnOnLights','turnOnSwitches'].includes(f))}> ${l}</label>`).join('')}</div>
                   <b>Detected entities</b>${roomEntities.length?roomEntities.map((e,i)=>{const o=cardSettings.entityOverrides?.[e.id]||{};return `<div class="room-entity"><label class="toggleline"><input type="checkbox" data-room-visible="${this.attr(e.id)}" ${checked(!o.hidden)}> <span><b>${this.esc(o.customName||e.name)}</b><small>${this.esc(e.id)} · ${this.esc(e.state)}</small></span></label><input data-room-name="${this.attr(e.id)}" value="${this.attr(o.customName||'')}" placeholder="Custom display name"><div><button data-room-up="${this.attr(e.id)}" ${i===0?'disabled':''}>↑</button><button data-room-down="${this.attr(e.id)}" ${i===roomEntities.length-1?'disabled':''}>↓</button></div></div>`}).join(''):'<p class="hint">No supported entities are assigned to this area. Hidden and unavailable entities remain listed when registry metadata is available.</p>'}
                 </div></details>`:''}
                 ${c.type==='Weather'?`<details open><summary>Weather</summary><div class="panel-settings"><div class="subgrid">${[['showTemperature','Temperature'],['showCondition','Condition'],['showWeatherIcon','Icon'],['showFeelsLike','Feels like'],['showTodayHighLow','High / low'],['showHumidity','Humidity'],['showWind','Wind'],['showPrecipitation','Precipitation'],['showDailyForecast','Daily forecast'],['showWeeklyForecast','Weekly forecast']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-card-setting-bool="${f}" ${checked(cardSettings[f])}> ${l}</label>`).join('')}</div><label>Forecast days<input type="number" min="1" max="10" data-card-setting-number="forecastDays" value="${cardSettings.forecastDays||5}"></label><div class="two"><label>Temperature unit<select data-card-setting-select="temperatureUnit">${['auto','celsius','fahrenheit'].map(x=>`<option ${x===(cardSettings.temperatureUnit||'auto')?'selected':''}>${x}</option>`).join('')}</select></label><label>Layout<select data-card-setting-select="layout">${['auto','compact','detailed'].map(x=>`<option ${x===(cardSettings.layout||'auto')?'selected':''}>${x}</option>`).join('')}</select></label></div><div class="two"><label>Icon size<select data-card-setting-select="iconSize">${['small','medium','large'].map(x=>`<option ${x===(cardSettings.iconSize||'medium')?'selected':''}>${x}</option>`).join('')}</select></label><label>Temperature size<select data-card-setting-select="mainTemperatureSize">${['small','medium','large'].map(x=>`<option ${x===(cardSettings.mainTemperatureSize||'medium')?'selected':''}>${x}</option>`).join('')}</select></label></div><label>Condition text size<select data-card-setting-select="conditionTextSize">${['small','medium','large'].map(x=>`<option ${x===(cardSettings.conditionTextSize||'medium')?'selected':''}>${x}</option>`).join('')}</select></label></div></details>`:''}
                 ${['Clock','Date'].includes(c.type)?`<details open><summary>Clock / date</summary><div class="panel-settings"><div class="subgrid">${[['use24Hour','24-hour'],['showSeconds','Seconds'],['showDate','Date'],['showDayOfWeek','Day of week']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-card-setting-bool="${f}" ${checked(cardSettings[f])}> ${l}</label>`).join('')}</div><label>Time zone<input data-card-setting-text="timeZoneId" value="${this.attr(cardSettings.timeZoneId||'system')}"></label><div class="two"><label>Date format<select data-card-setting-select="dateFormat">${['short','medium','long'].map(x=>`<option ${x===(cardSettings.dateFormat||'medium')?'selected':''}>${x}</option>`).join('')}</select></label><label>Alignment<select data-card-setting-select="alignment">${['start','center','end'].map(x=>`<option ${x===(cardSettings.alignment||'start')?'selected':''}>${x}</option>`).join('')}</select></label></div><label>Font scale<input type="number" min=".5" max="2" step=".05" data-card-setting-number="fontScale" value="${cardSettings.fontScale||1}"></label></div></details>`:''}
                 ${c.type==='RgbLight'?`<details open><summary>RGB light</summary><div class="panel-settings"><div class="subgrid">${[['showColorWheel','Color wheel'],['showBrightness','Brightness'],['showPresetColors','Preset colors'],['showRecentColors','Recent colors'],['showColorTemperature','Color temperature']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-card-setting-bool="${f}" ${checked(cardSettings[f])}> ${l}</label>`).join('')}</div><label>Favorite colors <small>comma-separated hex colors</small><input data-card-setting-list="favoriteColors" value="${this.attr((cardSettings.favoriteColors||[]).join(', '))}"></label></div></details>`:''}
                 ${c.type==='Cover'?`<details open><summary>Cover</summary><div class="panel-settings"><label>Control style<select data-card-setting-select="controlStyle">${['Slider','Shutter'].map(x=>`<option value="${x}" ${x===(cardSettings.controlStyle||'Slider')?'selected':''}>${x}</option>`).join('')}</select></label><label>Orientation<select data-card-setting-select="orientation">${['Horizontal','Vertical'].map(x=>`<option value="${x}" ${x===(cardSettings.orientation||'Horizontal')?'selected':''}>${x}</option>`).join('')}</select></label><div class="subgrid">${[['reverseDirection','Reverse'],['shortPressToggleOpenClose','Tap toggles'],['showOpen','Open'],['showStop','Stop'],['showClose','Close'],['showCurrentPosition','Current position'],['showPositionSlider','Position slider'],['showTilt','Tilt']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-card-setting-bool="${f}" ${checked(cardSettings[f])}> ${l}</label>`).join('')}</div><label>Preset positions <small>comma-separated percentages</small><input data-card-setting-number-list="presetPositions" value="${this.attr((cardSettings.presetPositions||[]).join(', '))}"></label></div></details>`:''}
                 ${c.type==='PagePopup'?`<details open><summary>Page popup</summary><div class="panel-settings">
                    <label>Popup page<select data-page-popup-target><option value="">Choose page</option>${(this.dashboard?.pages||[]).map(page=>`<option value="${this.attr(page.id)}" ${page.id===cardSettings.targetPageId?'selected':''}>${this.esc(page.title||page.id)}</option>`).join('')}</select></label>
                    <div class="subgrid"><label class="toggleline"><input type="checkbox" data-card-setting-bool="showTitle" ${checked(cardSettings.showTitle!==false)}> Title</label><label class="toggleline"><input type="checkbox" data-card-setting-bool="showSummary" ${checked(cardSettings.showSummary!==false)}> Summary</label></div>
                    <p class="hint">The card switch controls every light, switch, shutter, and AC used on the selected page, including entities of Room cards on that page.</p>
                    <b>Page OFF behavior</b><div class="subgrid">${[['lights','Turn off lights'],['switches','Turn off switches'],['closeCovers','Close shutters'],['turnOffClimate','Turn off AC']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-room-toggle="${f}" ${checked(cardSettings.roomToggle?.[f] ?? ['lights','switches'].includes(f))}> ${l}</label>`).join('')}</div>
                    <b>Page ON behavior</b><div class="subgrid">${[['turnOnLights','Turn on lights'],['turnOnSwitches','Turn on switches'],['openCovers','Open shutters'],['turnOnClimate','Turn on AC']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-room-toggle="${f}" ${checked(cardSettings.roomToggle?.[f] ?? ['turnOnLights','turnOnSwitches'].includes(f))}> ${l}</label>`).join('')}</div>
                 </div></details>`:''}
                 ${['Page','Navigation','NavigationButton'].includes(c.type)?`<details open><summary>Page navigation</summary><div class="panel-settings"><label>Target page ID<input data-card-setting-text="targetPageId" value="${this.attr(cardSettings.targetPageId||'')}"></label><div class="subgrid"><label class="toggleline"><input type="checkbox" data-card-setting-bool="showTitle" ${checked(cardSettings.showTitle!==false)}> Title</label><label class="toggleline"><input type="checkbox" data-card-setting-bool="showSummary" ${checked(cardSettings.showSummary!==false)}> Summary</label></div></div></details>`:''}
                 ${['Text','Header'].includes(c.type)?`<details open><summary>Text</summary><div class="panel-settings"><label>Text<textarea class="compact-textarea" data-custom-text>${this.esc(c.customText||'')}</textarea></label><div class="two"><label>Font scale<input type="number" min=".5" max="2" step=".05" data-card-setting-number="fontScale" value="${cardSettings.fontScale||1}"></label><label>Max lines<input type="number" min="1" max="20" data-card-setting-number="maxLines" value="${cardSettings.maxLines||6}"></label></div><label>Alignment<select data-card-setting-select="alignment">${['start','center','end'].map(x=>`<option ${x===(cardSettings.alignment||'start')?'selected':''}>${x}</option>`).join('')}</select></label><label class="toggleline"><input type="checkbox" data-card-setting-bool="bold" ${checked(cardSettings.bold)}> Bold</label></div></details>`:''}
                 ${c.type==='Connectivity'?`<details open><summary>Connectivity</summary><div class="panel-settings"><div class="subgrid">${[['showWifi','Wi-Fi'],['showHomeAssistant','Home Assistant'],['showInternet','Internet']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-card-setting-bool="${f}" ${checked(cardSettings[f])}> ${l}</label>`).join('')}</div>${[['wifiMode','Wi-Fi mode'],['homeAssistantMode','HA mode'],['internetMode','Internet mode']].map(([f,l])=>`<label>${l}<select data-card-setting-select="${f}">${['Hidden','IconOnly','TextOnly','IconAndText'].map(x=>`<option ${x===(cardSettings[f]||'IconAndText')?'selected':''}>${x}</option>`).join('')}</select></label>`).join('')}</div></details>`:''}
                 ${['SecuritySummary','Presence'].includes(c.type)?`<details><summary>Security rules</summary><div class="panel-settings"><label>Secure states <small>one per line: entity_id | state1, state2</small><textarea class="compact-textarea" data-security-rules>${this.esc((c.securityRules||[]).map(rule=>`${rule.entityId}|${(rule.secureStates||[]).join(',')}`).join('\n'))}</textarea></label></div></details>`:''}
                 ${c.type==='AlertControl'?`<label class="toggleline"><input type="checkbox" data-card-setting-bool="requireInstallerPin" ${checked(cardSettings.requireInstallerPin)}> Require installer PIN</label>`:''}
                 <button class="danger wide" data-del="${this.esc(c.id)}">Delete card</button>
              </div>
            </section>`:`<div class="empty select-card">Select a card in the screen preview to edit it here.</div>`}

            ${this.draft?`<details class="screen-settings"><summary>Screen / app settings</summary><div class="panel-settings">
              <div class="sync-note"><b>Applied values</b><span>Use “Sync from screen” above to replace the draft with the latest project reported by this panel.</span></div>
              <div class="floating-settings"><b>Identity & defaults</b><span>These values are stored in the same versioned project sent to the panel.</span></div>
              <label>Panel name<input data-panel-text="panelName" value="${this.attr(panel.panelName||'Stips Panel')}"></label>
              <div class="two"><label>Site<input data-panel-text="siteName" value="${this.attr(panel.siteName||'')}"></label><label>Assigned room<input data-panel-text="assignedRoom" value="${this.attr(panel.assignedRoom||'')}"></label></div>
              <label>App theme<select data-panel-select="appThemeId">${[['stips-v5-dark','Stips V5 Dark'],['stips-liquid-glass','Liquid Glass'],['stips-liquid-glass-light','Liquid Glass Light'],['stips-glass-home','STIPS Glass Home'],['midnight_waves','Midnight Waves'],['ember_obsidian','Ember Obsidian'],['electric_aurora','Electric Aurora'],['deep_sapphire','Deep Sapphire']].map(([id,label])=>`<option value="${id}" ${id===(panel.appThemeId||'stips-v5-dark')?'selected':''}>${label}</option>`).join('')}</select></label>
              <label>Default dashboard<select data-panel-select="defaultDashboardId"><option value="">Automatic</option>${(this.draft.dashboards||[]).map(x=>`<option value="${this.attr(x.id)}" ${x.id===panel.defaultDashboardId?'selected':''}>${this.esc(x.title)}</option>`).join('')}</select></label>
              <div class="two"><label>Time zone<input data-panel-text="appTimeZoneId" value="${this.attr(panel.appTimeZoneId||'system')}" placeholder="system"></label><label class="toggleline"><input type="checkbox" data-panel-bool="use24HourTime" ${checked(panel.use24HourTime!==false)}> 24-hour clock</label></div>
              <label class="toggleline"><input type="checkbox" data-panel-bool="kioskEnabled" ${checked(panel.kioskEnabled)}> Kiosk mode</label>
              <label class="toggleline"><input type="checkbox" data-panel-bool="forceFullScreen" ${checked(panel.forceFullScreen===true)}> Force Android system bars hidden</label>
              <label class="toggleline"><input type="checkbox" data-panel-bool="showTopBar" ${checked(panel.showTopBar!==false)}> Show top bar</label>
              <label>Top bar size<select data-topbar="size">${['Small','Large','ExtraLarge'].map(x=>`<option value="${x}" ${x===(top.size||'Small')?'selected':''}>${x==='ExtraLarge'?'Extra Large':x}</option>`).join('')}</select></label>
              <label>Connectivity<select data-topbar="connectivity">${topModeOptions(top.connectivity||'IconAndText')}</select></label>
              <label>Dashboard name<select data-topbar="dashboardName">${topModeOptions(top.dashboardName||'TextOnly')}</select></label>
              <label>Top-bar navigation<select data-topbar="navigation">${topModeOptions(top.navigation||'Hidden')}</select></label>
              <label>Settings shortcut<select data-topbar="settings">${topModeOptions(top.settings||'IconOnly')}</select></label>
              <label>Brightness shortcut<select data-topbar="brightness">${topModeOptions(top.brightness||'Hidden')}</select></label>
              <label>Volume shortcut<select data-topbar="volume">${topModeOptions(top.volume||'Hidden')}</select></label>
              <label>Custom text<select data-topbar="customTextMode">${topModeOptions(top.customTextMode||'Hidden')}</select></label>
              ${top.customTextMode && top.customTextMode!=='Hidden'?`<label>Custom top-bar text<input data-topbar="customText" value="${this.attr(top.customText||'')}" maxlength="80"></label>`:''}
              <label class="toggleline"><input type="checkbox" data-panel-bool="showNavigation" ${checked(panel.showNavigation!==false)}> Show navigator</label>
              <div class="subgrid"><label class="toggleline"><input type="checkbox" data-panel-bool="showHomeOverview" ${checked(panel.showHomeOverview===true)}> Home overview</label><label class="toggleline"><input type="checkbox" data-panel-bool="showInRecents" ${checked(panel.showInRecents!==false)}> Show in Recents</label><label class="toggleline"><input type="checkbox" data-panel-bool="swipeDashboards" ${checked(panel.swipeDashboards!==false)}> Swipe dashboards</label><label class="toggleline"><input type="checkbox" data-panel-bool="showDashboardIndicator" ${checked(panel.showDashboardIndicator!==false)}> Page indicator</label></div>
              <div class="subgrid"><label class="toggleline"><input type="checkbox" data-nav-visible="home" ${checked(navVisible('home'))}> Home</label><label class="toggleline"><input type="checkbox" data-nav-visible="entities" ${checked(navVisible('entities',false))}> Entities</label><label class="toggleline"><input type="checkbox" data-nav-visible="ha_dashboard" ${checked(navVisible('ha_dashboard',false))}> HA</label><label class="toggleline"><input type="checkbox" data-nav-visible="editor" ${checked(navVisible('editor'))}> Edit</label><label class="toggleline"><input type="checkbox" data-nav-visible="settings" ${checked(navVisible('settings'))}> Settings</label></div>
              <div class="floating-settings"><b>Floating action / recovery control</b><span>Drag the Action/Hidden marker in the screen preview, or use these exact controls. Hidden mode keeps the same long-press hotspot size and position.</span></div>
              <label class="toggleline"><input type="checkbox" data-panel-bool="showFloatingUiHandle" ${checked(panel.showFloatingUiHandle===true)}> Show action button</label>
              <label>Button opacity <b>${Math.round((panel.floatingButtonOpacity??.94)*100)}%</b><input type="range" min="0" max="1" step=".02" data-panel-number="floatingButtonOpacity" value="${panel.floatingButtonOpacity??.94}"></label>
              <label>Button / hidden hotspot size <b>${Math.round(Number(panel.floatingButton?.sizeDp||48))} dp</b><input type="range" min="32" max="96" step="1" data-floating-number="sizeDp" value="${panel.floatingButton?.sizeDp||48}"></label>
              <label>Short click action<select data-floating-select="shortClickAction"><option value="OpenMenu" ${(panel.floatingButton?.shortClickAction||'OpenMenu')==='OpenMenu'?'selected':''}>Open menu</option><option value="GoHome" ${panel.floatingButton?.shortClickAction==='GoHome'?'selected':''}>Go to Home</option></select></label>
              <div class="position-presets"><button data-floating-pos="0,0">Top left</button><button data-floating-pos="1,0">Top right</button><button data-floating-pos="0,1">Bottom left</button><button data-floating-pos="1,1">Bottom right</button></div>
              <label>Horizontal position <b>${Math.round(Number(panel.floatingButton?.positionX??0)*100)}%</b><input type="range" min="0" max="1" step=".01" data-floating-number="positionX" value="${panel.floatingButton?.positionX??0}"></label>
              <label>Vertical position <b>${Math.round(Number(panel.floatingButton?.positionY??1)*100)}%</b><input type="range" min="0" max="1" step=".01" data-floating-number="positionY" value="${panel.floatingButton?.positionY??1}"></label>
              <div class="subgrid"><label class="toggleline"><input type="checkbox" data-floating-bool="showNavigation" ${checked(panel.floatingButton?.showNavigation!==false)}> Restore bars</label><label class="toggleline"><input type="checkbox" data-floating-bool="openSettings" ${checked(panel.floatingButton?.openSettings!==false)}> Settings</label><label class="toggleline"><input type="checkbox" data-floating-bool="enterEditMode" ${checked(panel.floatingButton?.enterEditMode!==false)}> Edit</label><label class="toggleline"><input type="checkbox" data-floating-bool="exitKiosk" ${checked(panel.floatingButton?.exitKiosk===true)}> Exit kiosk</label></div>
              <label class="toggleline"><input type="checkbox" data-panel-bool="autoRotate" ${checked(panel.autoRotate!==false)}> Auto rotate</label>
              ${panel.autoRotate===false?`<label>Locked orientation<select data-panel-select="orientation">${['Landscape','Portrait'].map(x=>`<option value="${x}" ${x===(panel.orientation||'Landscape')?'selected':''}>${x==='Landscape'?'Horizontal':'Vertical'}</option>`).join('')}</select></label>`:''}
              <label>Performance<select data-panel-select="performanceMode">${['Auto','Normal','Lite'].map(x=>`<option value="${x}" ${x===(panel.performanceMode||'Auto')?'selected':''}>${x==='Lite'?'Low-End / Lite':x}</option>`).join('')}</select></label>
              <label>Hardware profile<select data-panel-select="hardwareProfile">${['Auto',...this.screenProfiles().map(x=>x.key),'Phone / Tablet'].map(x=>`<option value="${this.esc(x)}" ${x===(panel.hardwareProfile||'Auto')?'selected':''}>${this.esc(x)}</option>`).join('')}</select></label>
              <div class="floating-settings"><b>Screen scaling profile</b><span>Global scale is layered on top of each card's own Content zoom.</span></div>
              <div class="two"><button data-scale-preset="q7">Q7 preset</button><button data-scale-preset="4in">4-inch preset</button></div>
              <label>Card scale <b>${Number(scale.cardScale||1).toFixed(2)}×</b><input type="range" min=".7" max="1.8" step=".05" data-screen-scale="cardScale" value="${scale.cardScale||1}"></label>
              <label>Text scale <b>${Number(scale.textScale||1).toFixed(2)}×</b><input type="range" min=".7" max="1.8" step=".05" data-screen-scale="textScale" value="${scale.textScale||1}"></label>
              <label>Icon scale <b>${Number(scale.iconScale||1).toFixed(2)}×</b><input type="range" min=".7" max="1.8" step=".05" data-screen-scale="iconScale" value="${scale.iconScale||1}"></label>
              <label>Spacing<select data-screen-scale="spacing">${['Compact','Normal','Comfortable'].map(x=>`<option value="${x}" ${x===(scale.spacing||'Normal')?'selected':''}>${x}</option>`).join('')}</select></label>
              <label>Columns override<select data-screen-scale="columnsOverride"><option value="0" ${Number(scale.columnsOverride||0)===0?'selected':''}>Auto</option>${[1,2,3,4,5,6,7,8].map(x=>`<option value="${x}" ${Number(scale.columnsOverride)===x?'selected':''}>${x}</option>`).join('')}</select></label>
              <div class="floating-settings"><b>Gestures & installer access</b><span>Keep recovery gestures deliberate on public and kiosk panels.</span></div>
              <label>Long press <b>${Number(panel.longPressDurationMs||550)} ms</b><input type="range" min="350" max="1500" step="50" data-panel-number="longPressDurationMs" value="${panel.longPressDurationMs||550}"></label>
              <label>Touch sensitivity <b>${Number(panel.gestureSensitivity||1).toFixed(2)}×</b><input type="range" min=".5" max="2" step=".05" data-panel-number="gestureSensitivity" value="${panel.gestureSensitivity||1}"></label>
              <label>Installer unlock timeout<select data-panel-number="installerUnlockTimeoutMinutes">${[1,5,10,15,30,60].map(x=>`<option value="${x}" ${Number(panel.installerUnlockTimeoutMinutes||5)===x?'selected':''}>${x} minutes</option>`).join('')}</select></label>
            </div></details>`:''}
            ${this.draft?`<details><summary>Dashboard appearance</summary><div class="panel-settings">
              <div class="two"><label>Dashboard title<input data-dashboard-text="title" value="${this.attr(d?.title||'')}"></label><label>Dashboard icon<input data-dashboard-text="icon" value="${this.attr(d?.icon||'home')}"></label></div>
              <div class="subgrid"><label class="toggleline"><input type="checkbox" data-dashboard-bool="showHeader" ${checked(d?.showHeader!==false)}> Header</label><label class="toggleline"><input type="checkbox" data-dashboard-bool="lockScrolling" ${checked(d?.lockScrolling===true)}> Lock scrolling</label><label class="toggleline"><input type="checkbox" data-dashboard-bool="autoCompact" ${checked(d?.autoCompact!==false)}> Auto compact</label></div>
              <label>Theme mode<select data-dashboard-select="themeMode"><option value="FollowAppTheme" ${d?.themeMode!=='CustomDashboardTheme'?'selected':''}>Follow app</option><option value="CustomDashboardTheme" ${d?.themeMode==='CustomDashboardTheme'?'selected':''}>Custom dashboard theme</option></select></label>
              <label>Dashboard theme<input data-dashboard-text="themeId" value="${this.attr(d?.themeId||'stips-v5-dark')}"></label>
              <label>Background<select data-appearance-select="backgroundType">${['theme','gradient','image'].map(x=>`<option value="${x}" ${x===(appearance.backgroundType||'theme')?'selected':''}>${x}</option>`).join('')}</select></label>
              <div class="two"><label>Gradient start<input data-appearance-text="gradientStart" value="${this.attr(appearance.gradientStart||'#182A42')}"></label><label>Gradient end<input data-appearance-text="gradientEnd" value="${this.attr(appearance.gradientEnd||'#120A24')}"></label></div>
              <label>Background image URI<input data-appearance-text="backgroundImageUri" value="${this.attr(appearance.backgroundImageUri||'')}" placeholder="Android content URI"></label>
              <label>Gradient angle<input type="number" min="0" max="360" data-appearance-number="gradientAngle" value="${Number(appearance.gradientAngle??145)}"></label>
              <label>Overlay opacity<input type="range" min="0" max="1" step=".02" data-appearance-number="overlayOpacity" value="${Number(appearance.overlayOpacity??.18)}"></label>
              <label>Card opacity<input type="range" min=".1" max="1" step=".02" data-appearance-number="cardOpacity" value="${Number(appearance.cardOpacity??.62)}"></label>
              <label>Active-card opacity<input type="range" min=".1" max="1" step=".02" data-appearance-number="activeCardOpacity" value="${Number(appearance.activeCardOpacity??.78)}"></label>
            </div></details>`:''}
            ${this.draft?`<details><summary>PIN protection</summary><div class="panel-settings"><div class="subgrid">${[['settings','Settings'],['dashboardEdit','Dashboard edit'],['cardEdit','Card edit'],['navigationEdit','Navigation edit'],['exitKiosk','Exit kiosk'],['showInterfaceBars','Show interface bars'],['floatingProtectedActions','Floating actions'],['installerAdvanced','Installer advanced']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-pin-bool="${f}" ${checked(pin[f] ?? (f!=='settings'&&f!=='showInterfaceBars'&&f!=='floatingProtectedActions'))}> ${l}</label>`).join('')}</div></div></details>`:''}
            ${this.draft?`<details><summary>Sensor alerts</summary><div class="panel-settings">
              <label>Activation source<select data-alert-select="activationSource"><option value="LocalPanel" ${!alertHa?'selected':''}>Local panel</option><option value="HomeAssistantEntity" ${alertHa?'selected':''}>Home Assistant entity</option></select></label>
              ${alertHa?`<label>Control entity <small>input_boolean or switch; binary_sensor is follow-only</small><input list="stips-alert-activation-entities" data-alert-text="activationEntityId" placeholder="input_boolean.stips_alerts" value="${this.attr(alerts.activationEntityId||'')}"><datalist id="stips-alert-activation-entities">${alertEntityOptions}</datalist></label>
              ${alerts.activationEntityId?`<p class="hint">Current state: <b>${this.esc(this._hass?.states?.[alerts.activationEntityId]?.state==='on'?'Armed':this._hass?.states?.[alerts.activationEntityId]?.state==='off'?'Disarmed':'Unavailable – not armed')}</b></p>`:''}
              <label>Control mode<select data-alert-select="activationControlMode"><option value="FollowHomeAssistant" ${alerts.activationControlMode!=='TwoWay'?'selected':''}>Follow HA only</option><option value="TwoWay" ${alerts.activationControlMode==='TwoWay'?'selected':''} ${alertReadOnly?'disabled':''}>Two-way synchronization</option></select></label>
              <p class="hint">Create an Input Boolean helper in Home Assistant (Settings → Devices &amp; services → Helpers → Toggle), for example input_boolean.stips_alerts, then select it here.</p>`:''}
              <div class="subgrid">${[...(alertHa?[]:[['enabled','Alerts enabled']]),['wakeScreen','Wake screen'],['showPopup','Popup'],['soundEnabled','Sound']].map(([f,l])=>`<label class="toggleline"><input type="checkbox" data-alert-bool="${f}" ${checked(alerts[f] ?? f!=='enabled')}> ${l}</label>`).join('')}</div>
              <div class="two"><label>Arming delay<select data-alert-delay="armingDelaySeconds">${delayOptions(alerts.armingDelaySeconds)}</select></label><label>Alarm delay<select data-alert-delay="triggerDelaySeconds">${delayOptions(alerts.triggerDelaySeconds)}</select></label></div>
              <label>Tone<select data-alert-select="selectedTone">${['Emergency','Seismic','Evacuation','Siren','Alert','Pulse','Chime'].map(x=>`<option value="${x}" ${x===(alerts.selectedTone||'Siren')?'selected':''}>${x}</option>`).join('')}</select></label>
              <label>Volume <b>${Number(alerts.volume??80)}%</b><input type="range" min="0" max="100" data-alert-number="volume" value="${Number(alerts.volume??80)}"></label>
              <label>Rules <small>One per line: entity_id | trigger state | custom label | alarm delay seconds (blank = default, 0 = instant)</small><textarea class="compact-textarea rules" data-alert-rules>${this.esc(alertRules)}</textarea></label>
            </div></details>`:''}
            <details><summary>Revision history</summary><div class="revisions">${revisionHtml}</div></details>
            <details><summary>Advanced JSON editor</summary><textarea id="json">${jsonText}</textarea><button class="wide" data-apply-json>Apply JSON draft</button></details>
          </aside>
        </div>
      </div>${this.pickerHtml()}`;
    this.bind();
    this.restoreUiState();
  }

  bind() {
    const q=(s)=>this.shadowRoot.querySelector(s), qa=(s)=>[...this.shadowRoot.querySelectorAll(s)];
    q('[data-refresh]')?.addEventListener('click',()=>this.refresh(true));
    q('[data-sync]')?.addEventListener('click',()=>this.syncFromScreen());
    q('[data-push]')?.addEventListener('click',()=>this.push());
    q('[data-fleet-select]')?.addEventListener('change',e=>{this.fleetSelected=[...e.target.selectedOptions].map(x=>x.value);});
    qa('[data-bulk]').forEach(x=>x.addEventListener('click',()=>this.bulkCommand(x.dataset.bulk)));
    qa('[data-bulk-all]').forEach(x=>x.addEventListener('click',()=>this.bulkAll(x.dataset.bulkAll)));
    qa('[data-group]').forEach(x=>x.addEventListener('click',()=>this.selectFleetGroup(x.dataset.group)));
    q('[data-save-group]')?.addEventListener('click',()=>this.saveFleetGroup());
    q('[data-upload-apk]')?.addEventListener('click',()=>this.uploadApk());
    q('[data-install-update]')?.addEventListener('click',()=>this.installUpdate(false));
    q('[data-update-all]')?.addEventListener('click',()=>this.installUpdate(true));
    q('[data-apply-policies]')?.addEventListener('click',()=>this.applyDevicePolicies());
    q('[data-maintenance-unlock]')?.addEventListener('click',()=>this.maintenanceUnlock());
    q('[data-maintenance-lock]')?.addEventListener('click',()=>this.commandData('maintenance_relock',{}));
    q('[data-apply-system-update]')?.addEventListener('click',()=>this.commandData('set_system_update_policy',{policy:q('[data-system-update]')?.value||'system_default'}));
    q('[data-bugreport]')?.addEventListener('click',()=>this.commandData('request_bug_report',{}));
    q('[data-watchdog-apply]')?.addEventListener('click',()=>this.configureWatchdog());
    q('[data-diagnostics]')?.addEventListener('click',()=>this.requestAndDownloadDiagnostics());
    q('[data-create-backup]')?.addEventListener('click',()=>this.createBackup());
    qa('[data-restore-backup]').forEach(x=>x.addEventListener('click',()=>this.restoreBackup(x.dataset.restoreBackup)));
    q('[data-clone-screen]')?.addEventListener('click',()=>this.cloneScreen());
    q('[data-apply-profile]')?.addEventListener('click',()=>this.applyRemoteProfile(q('[data-remote-profile]')?.value||''));
    q('[data-provisioning]')?.addEventListener('click',()=>this.provisioningInfo());
    qa('[data-screen-scale]').forEach(x=>x.addEventListener('change',e=>this.updateScreenScale(e.target.dataset.screenScale,e.target.value)));
    qa('[data-scale-preset]').forEach(x=>x.addEventListener('click',()=>this.applyScalePreset(x.dataset.scalePreset==='q7'?'q7':'4in')));
    qa('[data-screen]').forEach(x=>x.onclick=()=>this.loadScreen(x.dataset.screen));
    q('[data-project-space]')?.addEventListener('change',e=>{this.projectSpace=e.target.value;this.dashIndex=0;this.pageIndex=0;this.selectedCardId='';this.render();});
    q('[data-dashboard]')?.addEventListener('change',e=>{this.dashIndex=Number(e.target.value);this.pageIndex=0;this.selectedCardId='';this.render();});
    q('[data-page]')?.addEventListener('change',e=>{this.pageIndex=Number(e.target.value);this.selectedCardId='';this.render();});
    q('[data-preview-profile]')?.addEventListener('change',e=>{this.previewProfile=e.target.value;const p=this.ensurePanelConfig();if(p){p.hardwareProfile=this.previewProfile==='actual'?'Auto':this.previewProfile;this.draftSource='draft';}this.render();});
    q('[data-preview-orientation]')?.addEventListener('change',e=>{this.previewOrientation=e.target.value;const p=this.ensurePanelConfig();if(p){if(this.previewOrientation==='screen')p.autoRotate=true;else{p.autoRotate=false;p.orientation=this.previewOrientation;}this.draftSource='draft';}this.render();});
    qa('[data-card]').forEach(x=>{
      x.onclick=(e)=>{if(e.target.closest('[data-del]'))return;this.selectedCardId=x.dataset.card;this.render();};
      x.ondragstart=()=>{this.dragCardId=x.dataset.card;};
      x.ondragover=e=>e.preventDefault();
      x.ondrop=e=>{if(this.dragFloating)return;e.preventDefault();e.stopPropagation();this.moveCard(this.dragCardId,x.dataset.card);};
    });
    const floatingDrag=q('[data-floating-drag]');
    if (floatingDrag) {
      floatingDrag.ondragstart=(e)=>{this.dragFloating=true;this.dragCardId=null;e.dataTransfer?.setData('text/plain','stips-floating');};
      floatingDrag.ondragend=()=>{this.dragFloating=false;};
    }
    const deviceScreen=q('.device-screen');
    if (deviceScreen) {
      deviceScreen.ondragover=(e)=>{if(this.dragFloating)e.preventDefault();};
      deviceScreen.ondrop=(e)=>{
        if(!this.dragFloating)return;
        e.preventDefault();
        const rect=deviceScreen.getBoundingClientRect();
        const buttonRect=floatingDrag?.getBoundingClientRect();
        const size=buttonRect?.width||0;
        const availX=Math.max(1,rect.width-size), availY=Math.max(1,rect.height-size);
        const x=(e.clientX-rect.left-size/2)/availX;
        const y=(e.clientY-rect.top-size/2)/availY;
        this.dragFloating=false;
        this.setFloatingPosition(x,y);
      };
    }
        qa('[data-del]').forEach(x=>x.onclick=(e)=>{e.stopPropagation();this.removeCard(x.dataset.del);});
    q('[data-add]')?.addEventListener('click',()=>this.openAddPicker());
    q('[data-edit-entities]')?.addEventListener('click',()=>this.openEntityPicker());
    q('[data-clear-entities]')?.addEventListener('click',()=>{const c=this.selectedCard;if(c){c.entityIds=[];this.draftSource='draft';this.render();}});
    qa('[data-field]').forEach(x=>x.addEventListener('change',e=>this.updateCard(e.target.dataset.field,e.target.value)));
    qa('[data-style-number]').forEach(x=>x.addEventListener('change',e=>this.updateCardStyle(e.target.dataset.styleNumber,Number(e.target.value))));
    qa('[data-style-bool]').forEach(x=>x.addEventListener('change',e=>this.updateCardStyle(e.target.dataset.styleBool,e.target.checked)));
    qa('[data-style-select]').forEach(x=>x.addEventListener('change',e=>this.updateCardStyle(e.target.dataset.styleSelect,e.target.value)));
    qa('[data-style-text]').forEach(x=>x.addEventListener('change',e=>this.updateCardStyle(e.target.dataset.styleText,e.target.value)));
    qa('[data-card-action]').forEach(x=>x.addEventListener('change',e=>this.updateCardAction(e.target.dataset.cardAction,e.target.value)));
    qa('[data-card-action-field]').forEach(x=>x.addEventListener('change',e=>{const [slot,field]=e.target.dataset.cardActionField.split(':');this.updateCardActionField(slot,field,e.target.value);}));
    qa('[data-visibility]').forEach(x=>x.addEventListener('change',e=>this.updateVisibility(e.target.dataset.visibility,e.target.type==='checkbox'?e.target.checked:e.target.value)));
    qa('[data-feature-bool]').forEach(x=>x.addEventListener('change',e=>this.updateCardFeature(e.target.dataset.featureBool,e.target.checked)));
    qa('[data-card-setting-bool]').forEach(x=>x.addEventListener('change',e=>this.updateCardSetting(e.target.dataset.cardSettingBool,e.target.checked)));
    qa('[data-card-setting-number]').forEach(x=>x.addEventListener('change',e=>this.updateCardSetting(e.target.dataset.cardSettingNumber,Number(e.target.value))));
    qa('[data-card-setting-text]').forEach(x=>x.addEventListener('change',e=>this.updateCardSetting(e.target.dataset.cardSettingText,e.target.value)));
    qa('[data-card-setting-select]').forEach(x=>x.addEventListener('change',e=>this.updateCardSetting(e.target.dataset.cardSettingSelect,e.target.value)));
    qa('[data-card-setting-list]').forEach(x=>x.addEventListener('change',e=>this.updateCardSettingList(e.target.dataset.cardSettingList,e.target.value)));
    qa('[data-card-setting-number-list]').forEach(x=>x.addEventListener('change',e=>this.updateCardSettingList(e.target.dataset.cardSettingNumberList,e.target.value,true)));
    qa('[data-graph-number]').forEach(x=>x.addEventListener('change',e=>this.updateCardGraph(e.target.dataset.graphNumber,Number(e.target.value))));
    qa('[data-graph-select]').forEach(x=>x.addEventListener('change',e=>this.updateCardGraph(e.target.dataset.graphSelect,e.target.value)));
    qa('[data-graph-bool]').forEach(x=>x.addEventListener('change',e=>this.updateCardGraph(e.target.dataset.graphBool,e.target.checked)));
    qa('[data-room-text]').forEach(x=>x.addEventListener('change',e=>this.updateCardRoom(e.target.dataset.roomText,e.target.value)));
    qa('[data-room-bool]').forEach(x=>x.addEventListener('change',e=>this.updateCardRoom(e.target.dataset.roomBool,e.target.checked)));
    q('[data-room-card-area]')?.addEventListener('change',e=>this.updateRoomCardField('areaId',e.target.value));
    q('[data-page-popup-target]')?.addEventListener('change',e=>this.updatePagePopupTarget(e.target.value));
    q('[data-room-domains]')?.addEventListener('change',e=>this.updateRoomCardField('visibleDomains',e.target.value.split(',').filter(Boolean)));
    q('[data-room-layout]')?.addEventListener('change',e=>this.updateRoomCardField('entityLayout',e.target.value));
    qa('[data-room-toggle]').forEach(x=>x.addEventListener('change',e=>this.updateRoomToggle(e.target.dataset.roomToggle,e.target.checked)));
    qa('[data-room-visible]').forEach(x=>x.addEventListener('change',e=>this.updateRoomOverride(e.target.dataset.roomVisible,'hidden',!e.target.checked)));
    qa('[data-room-name]').forEach(x=>x.addEventListener('change',e=>this.updateRoomOverride(e.target.dataset.roomName,'customName',e.target.value.trim()||null)));
    qa('[data-room-up]').forEach(x=>x.addEventListener('click',()=>this.moveRoomEntity(x.dataset.roomUp,-1)));
    qa('[data-room-down]').forEach(x=>x.addEventListener('click',()=>this.moveRoomEntity(x.dataset.roomDown,1)));
    q('[data-custom-text]')?.addEventListener('change',e=>this.updateCard('customText',e.target.value));
    q('[data-security-rules]')?.addEventListener('change',e=>this.updateSecurityRules(e.target.value));
    qa('[data-panel-bool]').forEach(x=>x.addEventListener('change',e=>{const f=e.target.dataset.panelBool,v=e.target.checked;if(f==='autoRotate'&&v)this.previewOrientation='screen';this.updatePanelField(f,v);}));
    qa('[data-panel-number]').forEach(x=>x.addEventListener('change',e=>this.updatePanelField(e.target.dataset.panelNumber,Number(e.target.value))));
    qa('[data-panel-text]').forEach(x=>x.addEventListener('change',e=>this.updatePanelField(e.target.dataset.panelText,e.target.value)));
    qa('[data-panel-select]').forEach(x=>x.addEventListener('change',e=>{const f=e.target.dataset.panelSelect,v=e.target.value;if(f==='hardwareProfile')this.previewProfile=this.screenProfiles().some(p=>p.key===v)?v:'actual';if(f==='orientation')this.previewOrientation=String(v).toLowerCase().startsWith('p')?'Portrait':'Landscape';this.updatePanelField(f,v);}));
    qa('[data-dashboard-bool]').forEach(x=>x.addEventListener('change',e=>this.updateDashboardField(e.target.dataset.dashboardBool,e.target.checked)));
    qa('[data-dashboard-select]').forEach(x=>x.addEventListener('change',e=>this.updateDashboardField(e.target.dataset.dashboardSelect,e.target.value)));
    qa('[data-dashboard-text]').forEach(x=>x.addEventListener('change',e=>this.updateDashboardField(e.target.dataset.dashboardText,e.target.value)));
    qa('[data-appearance-select]').forEach(x=>x.addEventListener('change',e=>this.updateAppearanceField(e.target.dataset.appearanceSelect,e.target.value)));
    qa('[data-appearance-text]').forEach(x=>x.addEventListener('change',e=>this.updateAppearanceField(e.target.dataset.appearanceText,e.target.value)));
    qa('[data-appearance-number]').forEach(x=>x.addEventListener('change',e=>this.updateAppearanceField(e.target.dataset.appearanceNumber,Number(e.target.value))));
    qa('[data-showroom-bool]').forEach(x=>x.addEventListener('change',e=>this.updateShowroomField(e.target.dataset.showroomBool,e.target.checked)));
    qa('[data-showroom-select]').forEach(x=>x.addEventListener('change',e=>this.updateShowroomField(e.target.dataset.showroomSelect,e.target.value)));
    qa('[data-showroom-text]').forEach(x=>x.addEventListener('change',e=>this.updateShowroomField(e.target.dataset.showroomText,e.target.value)));
    qa('[data-showroom-number]').forEach(x=>x.addEventListener('change',e=>this.updateShowroomField(e.target.dataset.showroomNumber,Number(e.target.value))));
    qa('[data-pin-bool]').forEach(x=>x.addEventListener('change',e=>this.updatePinField(e.target.dataset.pinBool,e.target.checked)));
    qa('[data-alert-bool]').forEach(x=>x.addEventListener('change',e=>this.updateAlertField(e.target.dataset.alertBool,e.target.checked)));
    qa('[data-alert-select]').forEach(x=>x.addEventListener('change',e=>this.updateAlertField(e.target.dataset.alertSelect,e.target.value)));
    qa('[data-alert-number]').forEach(x=>x.addEventListener('change',e=>this.updateAlertField(e.target.dataset.alertNumber,Number(e.target.value))));
    q('[data-alert-rules]')?.addEventListener('change',e=>this.updateAlertRules(e.target.value));
    qa('[data-alert-delay]').forEach(x=>x.addEventListener('change',e=>this.updateAlertField(e.target.dataset.alertDelay,Math.max(0,Math.min(600,Number(e.target.value)||0)))));
    qa('[data-alert-text]').forEach(x=>x.addEventListener('change',e=>{
      const value=e.target.value.trim()||null;
      this.updateAlertField(e.target.dataset.alertText,value);
      // A binary_sensor can only be followed; never leave it in two-way mode.
      if(value?.startsWith('binary_sensor.'))this.updateAlertField('activationControlMode','FollowHomeAssistant');
    }));
    qa('[data-topbar]').forEach(x=>x.addEventListener('change',e=>this.updateTopBarField(e.target.dataset.topbar,e.target.value)));
    qa('[data-nav-visible]').forEach(x=>x.addEventListener('change',e=>this.updateNavVisibility(e.target.dataset.navVisible,e.target.checked)));
    qa('[data-floating-bool]').forEach(x=>x.addEventListener('change',e=>this.updateFloatingField(e.target.dataset.floatingBool,e.target.checked)));
    qa('[data-floating-number]').forEach(x=>x.addEventListener('change',e=>this.updateFloatingNumber(e.target.dataset.floatingNumber,e.target.value)));
    qa('[data-floating-select]').forEach(x=>x.addEventListener('change',e=>this.updateFloatingField(e.target.dataset.floatingSelect,e.target.value)));
    qa('[data-floating-pos]').forEach(x=>x.addEventListener('click',()=>{const [px,py]=x.dataset.floatingPos.split(',').map(Number);this.setFloatingPosition(px,py);}));
    q('[data-apply-json]')?.addEventListener('click',()=>this.updateRaw(q('#json').value));
    qa('[data-rollback]').forEach(x=>x.onclick=()=>this.rollback(x.dataset.rollback));
    qa('[data-command]').forEach(x=>x.onclick=()=>this.command(x.dataset.command));
    qa('[data-save-template]').forEach(x=>x.onclick=()=>this.saveTemplate());
    qa('[data-template]').forEach(x=>x.onclick=()=>this.pushTemplate(x.dataset.template));

    qa('[data-picker-close]').forEach(x=>x.addEventListener('click',e=>{e.stopPropagation();this.closePicker();}));
    q('[data-picker-backdrop]')?.addEventListener('click',e=>{if(e.target===e.currentTarget)this.closePicker();});
    qa('[data-picker-tab]').forEach(x=>x.addEventListener('click',()=>{this.picker.tab=x.dataset.pickerTab;if(this.picker.tab==='builtins'&&this.picker.cardType==='Auto')this.picker.cardType=this.builtinCardTypes()[0];this.render();}));
    q('[data-picker-search]')?.addEventListener('input',e=>{this.picker.search=e.target.value;const pos=e.target.selectionStart;this.render();const n=this.shadowRoot.querySelector('[data-picker-search]');if(n){n.focus();n.setSelectionRange(pos,pos);}});
    q('[data-picker-domain]')?.addEventListener('change',e=>{this.picker.domain=e.target.value;this.render();});
    q('[data-picker-area]')?.addEventListener('change',e=>{this.picker.area=e.target.value;this.render();});
    q('[data-picker-type]')?.addEventListener('change',e=>{this.picker.cardType=e.target.value;this.render();});
    qa('[data-picker-entity]').forEach(x=>x.addEventListener('click',()=>this.togglePickerEntity(x.dataset.pickerEntity)));
    qa('[data-builtin]').forEach(x=>x.addEventListener('click',()=>{this.picker.cardType=x.dataset.builtin;this.render();}));
    q('[data-picker-apply]')?.addEventListener('click',()=>this.applyPicker());
  }

  cardTypes() { return ['Tile','EntityState','EntitiesList','Button','Toggle','Light','RgbLight','MultiLight','Switch','Climate','Thermostat','Cover','Fan','Lock','Alarm','Scene','Script','Sensor','Gauge','Progress','Graph','History','MultiSensor','Weather','Camera','Doorbell','Media','Vacuum','Presence','SecuritySummary','AlertControl','Energy','Area','Room','RoomPopup','PagePopup','Clock','Date','Text','PanelBrightness','PanelVolume','Connectivity','QuickActions','BatteryStatus','Page','Navigation','NavigationButton','Header','Spacer','Divider','Image']; }
  iconFor(t) { const m={Light:'☀',RgbLight:'◉',Climate:'♨',Thermostat:'♨',Cover:'▥',Room:'⌂',RoomPopup:'▤',PagePopup:'▤',Weather:'☁',Clock:'◷',Date:'▣',Text:'T',Media:'▶',SecuritySummary:'⌂',AlertControl:'⚠',Page:'▤',Camera:'◉',BatteryStatus:'▰',Connectivity:'⌁',Fan:'✣',Lock:'▣',PanelBrightness:'☀',PanelVolume:'♪',Spacer:'·',Divider:'—'}; return m[t]||'◆'; }
  esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  attr(v=''){return this.esc(v);}

  css(){return `
    :host{display:block;background:var(--primary-background-color,#0e1117);color:var(--primary-text-color,#f4f6f8);min-height:100vh;font-family:var(--paper-font-body1_-_font-family,Inter,system-ui,sans-serif)}*{box-sizing:border-box}
    .app{padding:20px;max-width:2100px;margin:auto}header{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:16px}h1{margin:3px 0 5px;font-size:28px;letter-spacing:-.03em}h2{margin:2px 0 0;font-size:22px}header p{margin:0;color:var(--secondary-text-color,#98a2b3)}.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--primary-color,#7c5cff);font-weight:800}.header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    button,select,input,textarea{font:inherit}button{border:1px solid var(--divider-color,#303643);background:var(--card-background-color,#171b24);color:inherit;border-radius:11px;padding:9px 12px;cursor:pointer}button:hover{border-color:var(--primary-color,#7c5cff)}button:disabled{opacity:.45;cursor:default}.primary{background:var(--primary-color,#6750a4);border-color:transparent;color:#fff}.wide{width:100%}.danger{color:#ff8a8a}.icon-btn{padding:3px 8px;border:0;background:transparent;font-size:20px}.message{padding:10px 14px;border:1px solid color-mix(in srgb,var(--primary-color,#6750a4) 45%,transparent);background:color-mix(in srgb,var(--primary-color,#6750a4) 12%,transparent);border-radius:12px;margin-bottom:14px}
    .fleet{padding:14px;margin-bottom:14px}.fleet-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.fleet-head>div:first-child{display:grid;gap:3px}.fleet-groups{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.group-chip{font-size:10px;padding:5px 7px;border:1px solid var(--divider-color,#303643);border-radius:999px}.fleet-stats{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-bottom:10px}.fleet-stats div{padding:9px;border-radius:10px;background:var(--secondary-background-color,#10141c)}.fleet-stats span,.fleet-stats b{display:block}.fleet-stats span{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.fleet-stats b{font-size:16px;margin-top:2px}.fleet-controls{display:grid;grid-template-columns:minmax(260px,420px) 1fr;gap:10px;align-items:end}.fleet-controls label{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.fleet-controls select{width:100%;margin-top:4px}.fleet-controls small{display:block;margin-top:4px}.fleet-buttons{display:flex;gap:6px;flex-wrap:wrap}.ota-grid{display:grid;grid-template-columns:2fr 1fr 1fr 2fr;gap:8px;align-items:end}.ota-grid label{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.ota-grid input{width:100%;margin-top:4px}.ota-actions{display:flex;gap:6px;flex-wrap:wrap}.update-meta,.progress-note{margin-top:8px;padding:8px;border-radius:9px;background:var(--secondary-background-color,#10141c);display:grid;gap:2px}.update-meta span{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.diagnostics-grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 9px;padding:8px;background:var(--secondary-background-color,#10141c);border-radius:10px;margin-bottom:8px;font-size:10px}.diagnostics-grid span{color:var(--secondary-text-color,#98a2b3)}.diagnostics-grid b{overflow-wrap:anywhere}.advanced-policy{padding:8px;border:1px solid #d65b64;border-radius:9px;display:grid;gap:6px}.panel-settings input[type=number]{width:100%;margin-top:4px}
        .layout{display:grid;grid-template-columns:235px minmax(540px,1fr) 360px;gap:14px;align-items:start}.panel{background:var(--card-background-color,#151922);border:1px solid var(--divider-color,#2a303b);border-radius:18px;min-width:0}.left,.right{padding:14px;max-height:calc(100vh - 130px);overflow:auto;position:sticky;top:10px}.workspace{overflow:hidden;min-height:650px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--secondary-text-color,#98a2b3);margin:8px 0 10px}.screens,.templates,.revisions{display:grid;gap:6px;margin-bottom:16px}.screen{display:grid;grid-template-columns:10px 1fr auto;text-align:left;gap:9px;align-items:center;padding:10px}.screen.active{border-color:var(--primary-color,#7c5cff);background:color-mix(in srgb,var(--primary-color,#6750a4) 12%,var(--card-background-color,#171b24))}.screen span:nth-child(2){min-width:0}.screen b,.screen small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.screen small,.template small{color:var(--secondary-text-color,#98a2b3);font-size:10px}.screen em{font-style:normal;font-size:11px}.dot{width:8px;height:8px;border-radius:50%;background:#666}.dot.on{background:#4fd49b;box-shadow:0 0 9px #4fd49b77}.dot.off{background:#e45c64;box-shadow:0 0 7px #e45c6444}.status{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}.status div{padding:9px;border-radius:10px;background:var(--secondary-background-color,#10141c)}.status span,.status b{display:block}.status span{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.status b{font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis}.presence.online{color:#4fd49b}.presence.offline{color:#e45c64}.applied{display:grid;gap:3px;padding:9px;border:1px solid var(--divider-color,#303643);border-radius:10px;margin-bottom:18px}.applied b{font-size:11px}.applied span{font-size:10px;color:var(--secondary-text-color,#98a2b3);line-height:1.4}.template{display:grid;grid-template-columns:auto 1fr;text-align:left;gap:1px 8px}.template span{grid-row:1/3}.commands{display:grid;grid-template-columns:1fr;gap:6px}.commands .danger{border-color:#d65b64;color:#ff9ca2}.last-command{margin-top:5px;padding-top:5px;border-top:1px solid var(--divider-color,#303643)}
    .toolbar{padding:11px;display:flex;gap:8px;align-items:end;border-bottom:1px solid var(--divider-color,#2a303b);flex-wrap:wrap}.toolbar label{font-size:10px;color:var(--secondary-text-color,#98a2b3)}select,input{display:block;background:var(--secondary-background-color,#0e1219);border:1px solid var(--divider-color,#303643);color:inherit;border-radius:9px;padding:8px;max-width:100%}.toolbar select{min-width:120px}.grow{flex:1}.preview-head{display:flex;justify-content:space-between;padding:14px 16px 7px;color:var(--secondary-text-color,#98a2b3);font-size:11px}.preview-head div>*{display:block}.preview-head b{font-size:17px;color:var(--primary-text-color,#fff)}
    .sim-meta{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:0 16px 8px;font-size:10px;color:var(--secondary-text-color,#98a2b3)}.sim-meta b{color:var(--primary-text-color,#fff)}.device-wrap{padding:4px 16px 22px;display:flex;justify-content:center}.device{width:min(100%,900px);max-height:72vh;background:#05070a;border:8px solid #222832;border-radius:20px;box-shadow:0 16px 42px #0006;overflow:hidden}.device-screen{height:100%;width:100%;display:flex;background:var(--primary-background-color,#0e1117);overflow:hidden;position:relative}.sim-rail{width:var(--rail);min-width:42px;background:var(--card-background-color,#171b24);border-right:1px solid var(--divider-color,#303643);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:5px 2px}.sim-rail span,.sim-bottom span{display:grid;place-items:center;gap:1px;min-width:0;color:var(--secondary-text-color,#98a2b3);font-size:12px}.sim-rail small,.sim-bottom small{font-size:5.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sim-main{flex:1;min-width:0;display:flex;flex-direction:column;container-type:inline-size;overflow:hidden}.sim-topbar{height:var(--top-h);min-height:24px;background:var(--card-background-color,#171b24);border-bottom:1px solid var(--divider-color,#303643);display:flex;align-items:center;justify-content:space-between;padding:0 2.3cqw;gap:2cqw}.sim-topbar div:first-child{min-width:0}.sim-topbar b,.sim-topbar small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sim-topbar b{font-size:1.8cqw}.sim-topbar small{font-size:1.05cqw;color:var(--secondary-text-color,#98a2b3)}.sim-top-actions{font-size:1.8cqw;display:flex;gap:1.8cqw}.sim-content{flex:1;min-height:0;overflow:auto;background:var(--primary-background-color,#0e1117)}.sim-grid{display:grid;gap:var(--gap);padding:var(--pad-y) var(--pad-x) calc(var(--pad-y) + 2cqw);align-items:start}.sim-card{min-height:8px;margin:0}.sim-card .card-copy b{font-size:clamp(7px,var(--title-size,1.5cqw),24px)}.sim-card .card-copy small{font-size:clamp(5px,var(--subtitle-size,.9cqw),16px)}.sim-card .card-icon{font-size:clamp(10px,var(--icon-size,2cqw),32px);min-width:var(--icon-min,20px)}.sim-card .delete{font-size:clamp(10px,var(--title-size,1.5cqw),24px);padding:0 3px}.sim-bottom{height:var(--bottom-h);min-height:36px;background:var(--card-background-color,#171b24);border-top:1px solid var(--divider-color,#303643);display:flex;align-items:center;justify-content:space-around;padding:2px 1cqw}.sim-floating{position:absolute;z-index:20;width:var(--float-size);height:var(--float-size);min-width:18px;min-height:18px;border-radius:999px;padding:0;display:grid;place-items:center;align-content:center;gap:0;cursor:grab;box-shadow:0 3px 12px #0007}.sim-floating span{font-size:clamp(8px,1.8cqw,18px);line-height:1}.sim-floating small{font-size:clamp(4px,.7cqw,8px);line-height:1;margin-top:1px}.sim-floating.visible{background:var(--primary-color,#6750a4);border-color:#ffffff66;color:#fff}.sim-floating.hidden{background:transparent;border:2px dashed color-mix(in srgb,var(--primary-color,#6750a4) 70%,#fff);color:var(--primary-color,#9d87ff);box-shadow:none}
    .dash-card{border:1px solid var(--divider-color,#303643);border-radius:clamp(5px,1.4cqw,14px);background:var(--secondary-background-color,#10141c);padding:clamp(4px,1cqw,11px);display:flex;align-items:center;gap:clamp(3px,.8cqw,9px);overflow:hidden;cursor:grab}.dash-card.selected{outline:2px solid var(--primary-color,#7c5cff);outline-offset:-2px}.card-icon{font-size:20px;min-width:20px}.card-copy{min-width:0;flex:1}.card-copy b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.15}.card-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--secondary-text-color,#98a2b3);margin-top:2px}
    .tabs{border-bottom:1px solid var(--divider-color,#303643);margin:-14px -14px 12px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}.tabs button{border:0;background:transparent}.tabs span{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.card-inspector{margin-bottom:14px}.selected-preview{display:flex;gap:10px;align-items:center;padding:10px;border-radius:12px;background:color-mix(in srgb,var(--primary-color,#6750a4) 10%,var(--secondary-background-color,#10141c));margin-bottom:11px}.selected-preview div{min-width:0}.selected-preview b,.selected-preview small{display:block;overflow:hidden;text-overflow:ellipsis}.selected-preview small{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.inspector,.panel-settings{display:grid;gap:10px}.inspector label,.panel-settings label,.field-label{font-size:11px;color:var(--secondary-text-color,#98a2b3)}.inspector input,.inspector select,.panel-settings select{width:100%;margin-top:4px}.inspector input[type=range]{display:block;width:100%;padding:0}.panel-settings .toggleline{display:flex;align-items:center;gap:8px;color:var(--primary-text-color,#fff)}.panel-settings .toggleline input{display:inline-block;width:auto;margin:0;padding:0}.panel-settings input[type=range]{display:block;width:100%;padding:0;margin-top:5px}.floating-settings{display:grid;gap:3px;margin-top:4px;padding:9px;border-radius:10px;background:color-mix(in srgb,var(--primary-color,#6750a4) 10%,var(--secondary-background-color,#10141c));border:1px solid color-mix(in srgb,var(--primary-color,#6750a4) 30%,var(--divider-color,#303643))}.floating-settings b{font-size:11px}.floating-settings span{font-size:10px;line-height:1.35;color:var(--secondary-text-color,#98a2b3)}.position-presets{display:grid;grid-template-columns:1fr 1fr;gap:6px}.position-presets button{padding:7px 8px;font-size:10px}.entity-chips{display:grid;gap:5px;margin:5px 0}.entity-chip{display:grid;padding:7px 8px;border:1px solid var(--divider-color,#303643);border-radius:9px;font-size:11px}.entity-chip small{font-size:9px;color:var(--secondary-text-color,#98a2b3);overflow:hidden;text-overflow:ellipsis}.entity-actions{display:flex;gap:6px;flex-wrap:wrap}.subgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hint,.empty{font-size:11px;line-height:1.45;color:var(--secondary-text-color,#98a2b3)}.empty.big{padding:50px 20px;text-align:center;grid-column:1/-1}.select-card{padding:35px 14px;text-align:center}.sync-note{display:grid;gap:3px;padding:9px;border-radius:10px;background:var(--secondary-background-color,#10141c)}.sync-note b{font-size:11px}.sync-note span{font-size:10px;color:var(--secondary-text-color,#98a2b3);line-height:1.4}details{margin-top:13px;border-top:1px solid var(--divider-color,#303643);padding-top:10px}summary{cursor:pointer;font-weight:700;font-size:12px;margin-bottom:8px}.revision{display:grid;grid-template-columns:auto 1fr;text-align:left;gap:2px 8px}.revision b{grid-row:1/3}.revision span,.revision small{font-size:10px}.revision small{color:var(--secondary-text-color,#98a2b3)}textarea{width:100%;height:330px;background:#090c11;color:#d9e1ec;border:1px solid var(--divider-color,#303643);border-radius:10px;padding:9px;font-family:ui-monospace,monospace;font-size:10px;resize:vertical;margin-bottom:8px}.compact-textarea{height:90px;margin:4px 0 0}.compact-textarea.rules{height:150px}
    .modal-backdrop{position:fixed;inset:0;z-index:1000;background:#0009;display:grid;place-items:center;padding:18px}.picker-modal{width:min(1050px,96vw);height:min(760px,92vh);background:var(--card-background-color,#151922);border:1px solid var(--divider-color,#303643);border-radius:20px;box-shadow:0 24px 70px #0009;display:flex;flex-direction:column;overflow:hidden}.picker-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 10px}.picker-tabs{display:flex;gap:6px;padding:0 16px 10px;border-bottom:1px solid var(--divider-color,#303643)}.picker-tabs button.active{background:color-mix(in srgb,var(--primary-color,#6750a4) 18%,var(--card-background-color,#171b24));border-color:var(--primary-color,#6750a4)}.picker-filters{display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:10px 16px}.picker-filters label{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.picker-filters .search{min-width:260px}.picker-filters input,.picker-filters select{width:100%;margin-top:4px}.picker-count{padding:0 16px 8px;font-size:10px;color:var(--secondary-text-color,#98a2b3)}.entity-list{flex:1;min-height:0;overflow:auto;padding:0 12px 10px;display:grid;align-content:start;gap:5px}.entity-row{display:grid;grid-template-columns:9px minmax(0,1fr) auto auto;gap:9px;align-items:center;text-align:left;padding:9px 10px}.entity-row.selected{border-color:var(--primary-color,#6750a4);background:color-mix(in srgb,var(--primary-color,#6750a4) 14%,var(--card-background-color,#171b24))}.entity-dot{width:7px;height:7px;border-radius:50%;background:#4fd49b}.entity-dot.off{background:#68707d}.entity-main{min-width:0}.entity-main b,.entity-main small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entity-main small{font-size:9px;color:var(--secondary-text-color,#98a2b3)}.entity-state{font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis}.suggested{font-size:9px;padding:4px 6px;border-radius:8px;background:var(--secondary-background-color,#10141c);color:var(--secondary-text-color,#98a2b3)}.builtin-grid{flex:1;overflow:auto;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;align-content:start}.builtin-card{min-height:90px;display:grid;place-items:center;gap:4px}.builtin-card span{font-size:26px}.builtin-card.selected{border-color:var(--primary-color,#6750a4);background:color-mix(in srgb,var(--primary-color,#6750a4) 14%,var(--card-background-color,#171b24))}.picker-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--divider-color,#303643);background:var(--card-background-color,#151922)}.picker-actions>span{font-size:10px;color:var(--secondary-text-color,#98a2b3)}.picker-actions>div{display:flex;gap:7px}
    @media(max-width:1250px){.layout{grid-template-columns:210px minmax(470px,1fr) 330px}.left{font-size:12px}}@media(max-width:980px){.layout{grid-template-columns:200px 1fr}.right{grid-column:1/-1;position:static;max-height:none}.device{max-height:none}}@media(max-width:720px){.app{padding:9px}.fleet-stats{grid-template-columns:repeat(2,1fr)}.fleet-controls,.ota-grid{grid-template-columns:1fr}header{align-items:start;flex-direction:column}.header-actions{justify-content:flex-start}.layout{display:block}.left,.right{position:static;max-height:none;margin-bottom:10px}.workspace{margin-bottom:10px;min-height:500px}.device-wrap{padding:4px 6px 14px}.sim-meta{padding:0 7px 7px}.picker-modal{width:100%;height:96vh}.picker-filters{display:grid;grid-template-columns:1fr 1fr}.picker-filters .search{grid-column:1/-1;min-width:0}.entity-row{grid-template-columns:8px minmax(0,1fr) auto}.suggested{display:none}}
  `}
}

customElements.define('stips-panel-editor', StipsPanelEditor);
