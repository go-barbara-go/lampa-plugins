(function () {
    'use strict';
    if (window.LampaTizenBuffer) return;

    var api = window.LampaTizenBuffer = {
        version: '0.2.0',
        status: 'Ожидание запуска Lampa',
        hooked: false,
        displayHooked: false,
        last: null
    };
    var started = false;
    var warned = false;
    var lampaAttempts = 0;
    var hookAttempts = 0;
    var ready = false;
    var followingReady = false;
    var active = false;
    var buffering = false;
    var percent = 0;
    var displayTimer;
    var label;
    var displayed = -1;
    var L;

    function show(message) {
        try { if (L && L.Noty) L.Noty.show(message); } catch (ignore) {}
    }

    function warn(message) {
        if (!warned) { warned = true; show(message); }
    }

    function read(name, fallback) {
        try { return L.Storage.get(name, fallback); }
        catch (ignore) { return fallback; }
    }

    function enabled() {
        var value = read('ltb_enabled', true);
        return value !== false && value !== 'false' && value !== 0 && value !== '0';
    }

    function seconds(name, fallback, maximum) {
        var value = Number(read(name, fallback));
        if (value === 0) return 0;
        return isFinite(value) && value >= 4 && value <= maximum && Math.floor(value) === value
            ? value : fallback;
    }

    function ordinaryVideo() {
        // Read at open(), not setListener(): Lampa registers the listener before
        // assigning the URL. Missing metadata is excluded.
        var data = L.Player && L.Player.playdata && L.Player.playdata();
        return !!data && typeof data === 'object' && !data.iptv && !data.iptv_player && !data.tv;
    }

    function resetDisplay() {
        window.clearInterval(displayTimer);
        displayTimer = undefined;
        buffering = false;
        percent = 0;
        displayed = -1;
        if (label) label.style.display = 'none';
    }

    function resetPlayback() {
        active = false;
        resetDisplay();
    }

    function renderPercent() {
        if (!active || !enabled() || !buffering || document.hidden) {
            resetDisplay();
            return;
        }
        if (!label) {
            var root = L.PlayerVideo && L.PlayerVideo.render && L.PlayerVideo.render();
            root = root && (root[0] || root);
            if (!root || !root.appendChild) return;
            label = document.createElement('div');
            label.className = 'ltb-buffer-progress';
            label.style.cssText = 'position:absolute;right:2em;top:2em;z-index:20;' +
                'width:9em;white-space:nowrap;text-align:center;pointer-events:none;' +
                'padding:0.45em 0.65em;border-radius:0.3em;background:rgba(0,0,0,0.7);' +
                'color:#fff;font-variant-numeric:tabular-nums;';
            root.appendChild(label);
        }
        if (displayed !== percent) {
            label.textContent = 'Buffer: ' + percent + '%';
            displayed = percent;
        }
        label.style.display = 'block';
    }

    function bufferingStart() {
        resetDisplay();
        if (!active || !enabled() || document.hidden) return;
        buffering = true;
        renderPercent();
        displayTimer = window.setInterval(function () {
            try { renderPercent(); } catch (ignore) { resetDisplay(); }
        }, 2000);
    }

    function observe(name, args) {
        try {
            if (name === 'onbufferingstart') bufferingStart();
            else if (name === 'onbufferingprogress' && buffering) {
                var value = Number(args[0]);
                if (isFinite(value)) percent = Math.max(0, Math.min(100, Math.round(value)));
            } else if (name === 'onbufferingcomplete') resetDisplay();
            else if (name === 'onstreamcompleted' || name === 'onerror' || name === 'onerrormsg') resetPlayback();
        } catch (ignore) { resetDisplay(); }
    }

    function wrapListener(original) {
        // Do not mutate Lampa's listener or replace its other native callbacks.
        var wrapped = {};
        Object.keys(original).forEach(function (name) { wrapped[name] = original[name]; });
        ['onbufferingstart', 'onbufferingprogress', 'onbufferingcomplete',
            'onstreamcompleted', 'onerror', 'onerrormsg'].forEach(function (name) {
            var callback = original[name];
            // Preserve native validation of malformed callback fields.
            if (callback != null && typeof callback !== 'function') return;
            wrapped[name] = function () {
                observe(name, arguments);
                if (typeof callback === 'function') return callback.apply(this, arguments);
            };
        });
        return wrapped;
    }

    function apply(av) {
        api.last = { skipped: true, accepted: false };
        if (!ordinaryVideo()) {
            api.last.reason = 'iptv-or-unknown';
            api.status = 'IPTV или неизвестный источник: настройки не меняются.';
            return;
        }
        if (!enabled()) {
            api.last.reason = 'disabled';
            api.status = 'Отключён. Для полного сброса перезапустите Lampa.';
            return;
        }
        active = true;
        var preset = seconds('ltb_preset', 0, 300);
        if (!preset) {
            api.last.reason = 'default';
            api.status = 'По умолчанию: параметры AVPlay не меняются. После своих настроек перезапустите Lampa для сброса.';
            return;
        }
        var start = seconds('ltb_play_override', 0, 300) || preset;
        var resume = seconds('ltb_resume_override', 0, 300) || preset;
        var timeoutValue = read('ltb_wait_timeout', 'auto');
        var timeout = timeoutValue === 'auto' ? Math.max(60, 2 * Math.max(start, resume)) :
            seconds('ltb_wait_timeout', Math.max(60, 2 * Math.max(start, resume)), 600);
        var errors = [];
        api.last = { start: start, resume: resume, timeout: timeout, accepted: false, errors: errors };

        function attempt(label, callback) {
            try { callback(); }
            catch (error) {
                errors.push(label + ': ' + (error && error.name ? error.name : 'ошибка') +
                    (error && error.message ? ' (' + error.message + ')' : ''));
            }
        }

        // open() has completed synchronously; AVPlay must now be IDLE.
        if (av.getState() !== 'IDLE') {
            throw new Error('AVPlay не в состоянии IDLE');
        }
        attempt('Старт', function () {
            av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', start);
        });
        attempt('Возобновление', function () {
            av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', resume);
        });
        if (timeout) attempt('Таймаут', function () { av.setTimeoutForBuffering(timeout); });

        api.last.accepted = errors.length === 0;
        if (errors.length) {
            api.status = 'Не все параметры применены: ' + errors.join('; ');
            warn('Буфер Tizen: плеер отклонил настройки. Откройте «Проверить состояние».');
        } else {
            api.status = 'AVPlay принял: старт ' + start + ' с, возобновление ' + resume +
                ' с; таймаут ' + (timeout ? timeout + ' с' : 'не меняется') +
                '. Реальный объём буфера не измерен.';
        }
    }

    function installHook() {
        if (api.hooked) return;
        hookAttempts++;
        var av;
        try { av = window.webapis && window.webapis.avplay; } catch (ignore) {}
        if (!av || typeof av.open !== 'function') {
            api.status = 'AVPlay недоступен. Нужны приложение Tizen и плеер Tizen.';
            if (hookAttempts < 120) window.setTimeout(installHook, 500);
            return;
        }

        var originalOpen = av.open;
        var wrappedOpen = function () {
            resetPlayback();
            // Do not catch the original player's error or change its return value.
            var result = originalOpen.apply(this, arguments);
            try { apply(av); }
            catch (error) {
                api.status = 'Буфер не настроен: ' + (error.message || String(error));
                warn(api.status);
            }
            return result;
        };
        var originalListener = av.setListener;
        var wrappedListener = function (listener) {
            // Leave invalid native arguments for AVPlay to validate itself.
            var args = Array.prototype.slice.call(arguments);
            if (listener && typeof listener === 'object') {
                try { args[0] = wrapListener(listener); }
                catch (ignore) { args[0] = listener; }
            }
            return originalListener.apply(this, args);
        };
        try {
            av.open = wrappedOpen;
            if (av.open !== wrappedOpen) throw new Error('AVPlay.open защищён от изменения');
            api.hooked = true;
            if (typeof originalListener === 'function') {
                try {
                    av.setListener = wrappedListener;
                    api.displayHooked = av.setListener === wrappedListener;
                } catch (ignore) {}
            }
            api.status = 'Подключён. Откройте видео плеером Tizen, затем проверьте состояние.';
            if (!api.displayHooked) api.status += ' Индикатор буферизации недоступен.';
        } catch (error) {
            api.status = 'Не удалось подключиться к AVPlay: ' + (error.message || String(error));
            warn('Буфер Tizen: эта версия ТВ не позволяет подключить плагин. Подробности в настройках.');
        }
    }

    function addSelect(name, title, description, fallback, values) {
        L.SettingsApi.addParam({
            component: 'tizen_buffer',
            param: { name: name, type: 'select', values: values, default: String(fallback) },
            field: { name: title, description: description }
        });
    }

    function start() {
        if (started) return;
        L = window.Lampa;
        if (!L || !L.SettingsApi || !L.Storage) return;
        started = true;
        var choices = { '0': 'Из пресета', '5': '5 с', '10': '10 с', '15': '15 с', '20': '20 с',
            '30': '30 с', '45': '45 с', '60': '60 с', '90': '90 с', '120': '120 с',
            '180': '180 с', '300': '300 с' };
        L.SettingsApi.addComponent({
            component: 'tizen_buffer', name: 'Буфер Tizen',
            icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 22h8M12 18v4M7 9v4m5-6v8m5-6v4" stroke="currentColor" stroke-width="2"/></svg>'
        });
        L.SettingsApi.addParam({
            component: 'tizen_buffer',
            param: { name: 'ltb_enabled', type: 'trigger', default: true },
            field: { name: 'Включить', description: 'Обычные видео AVPlay / Tizen. IPTV исключён. После отключения полностью перезапустите Lampa.' }
        });
        addSelect('ltb_preset', 'Буфер видео',
            'Применяется при следующем открытии видео. Начните с 30 с. Большие значения экспериментальные; постоянный запас не гарантируется. Для возврата к умолчанию перезапустите Lampa.', 0,
            { '0': 'По умолчанию', '30': '30 с', '60': '60 с', '120': '120 с', '180': '180 с', '300': '300 с' });
        addSelect('ltb_play_override', 'Дополнительно: буфер перед стартом',
            'Переопределяет пресет: секунды видео до запуска. При пресете «По умолчанию» игнорируется.', 0, choices);
        addSelect('ltb_resume_override', 'Дополнительно: буфер при возобновлении',
            'Переопределяет пресет после нехватки данных, паузы или перемотки. При пресете «По умолчанию» игнорируется.', 0, choices);
        addSelect('ltb_wait_timeout', 'Дополнительно: таймаут ожидания',
            'Реальное время, НЕ размер буфера. Авто: максимум из 60 с и двойного порога. По истечении AVPlay может завершить буферизацию раньше цели. При пресете «По умолчанию» игнорируется.', 'auto',
            { 'auto': 'Авто', '0': 'Не менять', '20': '20 с', '30': '30 с', '60': '60 с',
                '120': '120 с', '180': '180 с', '240': '240 с', '360': '360 с', '600': '600 с' });
        L.SettingsApi.addParam({
            component: 'tizen_buffer', param: { type: 'button' },
            field: { name: 'Проверить состояние', description: 'После открытия видео показывает результат последнего вызова API, а не фактический запас видео.' },
            onChange: function () {
                if (!enabled()) show('Плагин отключён. Для полного сброса перезапустите Lampa.');
                else show(api.status);
            }
        });
        if (L.Player && L.Player.listener) {
            L.Player.listener.follow('start', resetPlayback);
            L.Player.listener.follow('destroy', resetPlayback);
        }
        if (L.PlayerVideo && L.PlayerVideo.listener) {
            L.PlayerVideo.listener.follow('destroy', function () {
                resetPlayback();
                if (label && label.parentNode) label.parentNode.removeChild(label);
                label = undefined;
            });
        }
        document.addEventListener('visibilitychange', function () {
            // No state queries or native calls while Lampa restores AVPlay.
            if (document.hidden) resetDisplay();
        });
        installHook();
    }

    function waitForLampa() {
        if (started) return;
        lampaAttempts++;
        L = window.Lampa;
        if (L && L.Listener && !followingReady) {
            followingReady = true;
            L.Listener.follow('app', function (event) {
                if (event.type === 'ready') { ready = true; start(); }
            });
        }
        if (window.appready || ready) start();
        if (!started && lampaAttempts < 120) window.setTimeout(waitForLampa, 500);
    }
    waitForLampa();
}());
