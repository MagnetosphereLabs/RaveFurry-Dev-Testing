"""This module contains all url endpoints and maps them to their corresponding functions."""
from typing import List, Union

from django.contrib.auth.views import LoginView
from django.urls import URLPattern, URLResolver, include, path
from django.views.generic import RedirectView

from core import base
from core import moderation
from core.musiq import controller as musiq_controller
from core.musiq import musiq
from core.musiq import song_cache, search
from core import state_handler
from core import ui_notifications
from core import visualizer
from core import tutorial
from core.authentication import ModeratorAuthenticationForm

urlpatterns: List[Union[URLPattern, URLResolver]] = [
    path("visualizer/background/", visualizer.background, name="visualizer-background"),
    path("visualizer/features/", visualizer.transport, name="visualizer-transport"),
    path("visualizer/features.json", visualizer.features, name="visualizer-features"),
    path("", base.landing, name="base"),
    path("afterhours/", base.afterhours, name="afterhours"),
    path("afterhours/top-songs/", base.afterhours_top_songs, name="afterhours-top-songs"),
    path("afterhours/history/", base.afterhours_history, name="afterhours-history"),
    path("p/", musiq.embed, name="musiq"),
    path("song-artwork/<str:video>/", song_cache.artwork, name="song-artwork"),
    path("api/musiq/search/", search.search, name="song-search"),
    path("tutorial/player/", tutorial.player, name="tutorial-player"),
    path("musiq/", RedirectView.as_view(pattern_name="base", permanent=False)),
    path("lights/", RedirectView.as_view(pattern_name="base", permanent=False), name="lights"),
    path("stream/", base.no_stream, name="no-stream"),
    path("network-info/", RedirectView.as_view(pattern_name="base", permanent=False), name="network-info"),
    path("settings/", base.settings_disabled, name="settings"),
    path("moderator/", moderation.dashboard, name="moderator"),
    path(
        "moderator-login/",
        LoginView.as_view(
            template_name="furatic_login.html",
            authentication_form=ModeratorAuthenticationForm,
            redirect_authenticated_user=True,
            next_page="moderator",
        ),
        name="furatic-login",
    ),
    path("accounts/", include("django.contrib.auth.urls")),
    path("login/", RedirectView.as_view(pattern_name="login", permanent=False)),
    path("logged-in/", base.logged_in, name="logged-in"),
    path("logout/", RedirectView.as_view(pattern_name="logout", permanent=False)),
    path(
        "api/",
        include(
            [
                path("site-mode/", base.site_mode_status, name="site-mode-status"),
                path("notifications/", ui_notifications.notifications, name="ui-notifications"),
                path(
                    "moderator/",
                    include(
                        [
                            path("state/", moderation.state, name="moderator-state"),
                            path(
                                "remove-song/",
                                moderation.remove_song,
                                name="moderator-remove-song",
                            ),
                            path(
                                "skip-current/",
                                moderation.skip_current_song,
                                name="moderator-skip-current",
                            ),
                            path("ban-ip/", moderation.ban_ip, name="moderator-ban-ip"),
                            path(
                                "unban-ip/",
                                moderation.unban_ip,
                                name="moderator-unban-ip",
                            ),
                            path(
                                "whitelist-ip/",
                                moderation.whitelist_ip,
                                name="moderator-whitelist-ip",
                            ),
                            path(
                                "unwhitelist-ip/",
                                moderation.unwhitelist_ip,
                                name="moderator-unwhitelist-ip",
                            ),
                            path(
                                "site-mode/",
                                moderation.set_site_mode,
                                name="moderator-site-mode",
                            ),
                            path(
                                "request-settings/",
                                moderation.set_request_settings,
                                name="moderator-request-settings",
                            ),
                            path(
                                "blocklists/add/",
                                moderation.add_blocklist,
                                name="moderator-add-blocklist",
                            ),
                            path(
                                "blocklists/rename/",
                                moderation.rename_blocklist,
                                name="moderator-rename-blocklist",
                            ),
                            path(
                                "blocklists/remove/",
                                moderation.remove_blocklist,
                                name="moderator-remove-blocklist",
                            ),
                            path("accounts/save/", moderation.save_moderator_account, name="moderator-account-save"),
                            path("accounts/delete/", moderation.delete_moderator_account, name="moderator-account-delete"),
                            path("identity-search/", moderation.identity_search, name="moderator-identity-search"),
                            path("audit-search/", moderation.audit_search, name="moderator-audit-search"),
                            path("review-song/", moderation.review_song, name="moderator-review-song"),
                            path("song-details/", moderation.song_details, name="moderator-song-details"),
                        ]
                    ),
                ),
            ]
        ),
    ),
]

# Explicit transport contracts used by landing, embedded queue and moderation.
# Internal playback/controller functions remain available to Python callers.
base_paths = []
musiq_paths = [
    path("request-music/", musiq.request_music, name="request-music"),
    path("own-song-state/", musiq_controller.own_song_state, name="own-song-state"),
    path("remove-own-song/", musiq_controller.remove_own_song, name="remove-own-song"),
    path("played-history/", musiq_controller.played_history, name="played-history"),
    path("vote/", musiq_controller.vote, name="vote"),
]
lights_paths = []
settings_paths = []
urlpatterns += [
    path("ajax/musiq/state/", state_handler.get_state, {"module": musiq}, name="musiq-state"),
    path("ajax/musiq/", include(musiq_paths)),
]
