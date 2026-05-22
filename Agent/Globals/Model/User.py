from datetime import datetime
from Globals.Enumerations.AuthenticationProviders import AuthenticationProviders
from Globals.Enumerations.UserRoles import UserRoles


class User:
    def __init__(self, id: str = None, display_name: str = None, provider: AuthenticationProviders = AuthenticationProviders(0), join_date: datetime = datetime.now(), preferences: dict = None, role: UserRoles = UserRoles(0), profile_picture_url: str = '', additional_data: dict = None) -> None:
        self.set_id(id)
        self.set_display_name(display_name)
        self.set_provider(provider)
        self.set_join_date(join_date)
        self.set_preferences(preferences)
        self.set_role(role)
        self.set_profile_picture_url(profile_picture_url)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def set_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__id = value

    def get_display_name(self) -> str:
        return self.__display_name

    def set_display_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__display_name = value

    def get_provider(self) -> AuthenticationProviders:
        return self.__provider

    def set_provider(self, value: AuthenticationProviders) -> None:
        if value is not None:
            valid_values = list(AuthenticationProviders)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__provider = value

    def get_join_date(self) -> datetime:
        return self.__join_date

    def set_join_date(self, value: datetime) -> None:
        if value is not None:
            if isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    value = datetime.now()
            elif not isinstance(value, datetime):
                value = datetime.now()
        else:
            value = datetime.now()
        self.__join_date = value

    def get_preferences(self) -> dict:
        return self.__preferences

    def set_preferences(self, value: dict) -> None:
        self.__preferences = value

    def get_role(self) -> UserRoles:
        return self.__role

    def set_role(self, value: UserRoles) -> None:
        if value is not None:
            valid_values = list(UserRoles)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__role = value

    def get_profile_picture_url(self) -> str:
        return self.__profile_picture_url

    def set_profile_picture_url(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 2048:
                value = value[:2048]
        self.__profile_picture_url = value

    def get_additional_data(self) -> dict:
        return self.__additional_data

    def set_additional_data(self, value: dict) -> None:
        self.__additional_data = value

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'displayName': self.get_display_name(),
            'provider': int(self.get_provider().value) if self.get_provider() is not None else None,
            'joinDate': self.get_join_date().isoformat() if self.get_join_date() is not None else None,
            'preferences': self.get_preferences(),
            'role': int(self.get_role().value) if self.get_role() is not None else None,
            'profilePictureUrl': self.get_profile_picture_url(),
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'User':
        instance = cls(
            id=data.get('id'),
            display_name=data.get('displayName'),
            provider=AuthenticationProviders(data.get('provider')) if data.get('provider') is not None else None,
            join_date=datetime.fromisoformat(data.get('joinDate')) if data.get('joinDate') is not None else None,
            preferences=data.get('preferences'),
            role=UserRoles(data.get('role')) if data.get('role') is not None else None,
            profile_picture_url=data.get('profilePictureUrl'),
            additional_data=data.get('additionalData')
        )
        return instance
