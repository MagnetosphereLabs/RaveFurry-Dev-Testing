"""FURATIC moderator login behavior."""
from django import forms
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.validators import UnicodeUsernameValidator


class ModeratorAuthenticationForm(AuthenticationForm):
    """Explain deliberate moderator deactivation without changing normal failures."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["username"].validators.append(UnicodeUsernameValidator())
        self.fields["password"] = forms.CharField(
            label="Password", strip=False, max_length=4096,
            widget=forms.PasswordInput(attrs={"autocomplete": "current-password", "maxlength": 4096}),
        )

    def clean(self):
        if hasattr(self.data, "getlist") and any(
                len(self.data.getlist(name)) > 1 for name in ("username", "password")):
            raise forms.ValidationError("Please submit one username and one password.", code="duplicate")
        username = self.cleaned_data.get("username")
        password = self.cleaned_data.get("password")
        if username and password:
            user = get_user_model().objects.filter(username__iexact=username).first()
            if user is not None and not user.is_active and user.check_password(password):
                raise forms.ValidationError(
                    "The account you are trying to use is currently deactivated, it will be reactivated when your next event starts. Contact staff if this is a mistake!",
                    code="inactive",
                )
            self.user_cache = authenticate(self.request, username=username, password=password)
            if self.user_cache is None:
                raise self.get_invalid_login_error()
            self.confirm_login_allowed(self.user_cache)
        return self.cleaned_data

