(function () {
    'use strict';
    function disableTrailers() {
        window.lampa_settings = window.lampa_settings || {};
        window.lampa_settings.disable_features = window.lampa_settings.disable_features || {};
        window.lampa_settings.disable_features.trailers = true;
    }
    disableTrailers();
    if (!window.appready && window.Lampa && window.Lampa.Listener) {
        window.Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') disableTrailers();
        });
    }
}());
