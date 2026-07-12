import base64
import json
import os

from google.cloud import storage
from google.cloud.storage import Client, Bucket
from Globals.Enumerations.StorageTargets import StorageTargets
from Globals.Utility.EnvironmentLoader import EnvironmentLoader


class Persistence:
    __GOOGLE_CLOUD_STORAGE_BUCKET_NAME = "mindmeld-bucket"
    __default_storage_target = StorageTargets.GOOGLE_CLOUD_STORAGE
    __INFORMATION_SOURCE_DIRECTORY = "InformationSources"
    __TASKS_DIRECTORY = "Tasks"

    __storage_client: Client = None
    __bucket: Bucket = None

    @staticmethod
    def __initialize():
        if Persistence.__storage_client is None:
            # Burst workers run this Agent in a container with no repo Common/
            # directory, so the storage service-account key is injected as base64 env
            # (never baked into the image — see Agent/.dockerignore + Dock's
            # BurstFleetSettings). On the base node no such variable is set and the key
            # is read from disk: Common/Credentials/mindmeld-storage.<environment>.json,
            # selected per environment exactly the way EnvironmentLoader/Dock resolve
            # it, so every service authenticates with its own environment's credential.
            storage_credentials_base64 = os.getenv("MINDMELD_STORAGE_CREDENTIALS_BASE64")
            if storage_credentials_base64:
                credentials_info = json.loads(base64.b64decode(storage_credentials_base64))
                Persistence.__storage_client = storage.Client.from_service_account_info(credentials_info)
            else:
                environment_name = EnvironmentLoader.resolve_environment_name()
                credentials_path = os.path.join(
                    os.path.dirname(__file__), "..", "..", "..", "..",
                    "Common", "Credentials", f"mindmeld-storage.{environment_name}.json"
                )
                Persistence.__storage_client = storage.Client.from_service_account_json(credentials_path)
            Persistence.__bucket = Persistence.__storage_client.bucket(
                Persistence.__GOOGLE_CLOUD_STORAGE_BUCKET_NAME
            )

    @staticmethod
    def get_information_source_directory():
        return Persistence.__INFORMATION_SOURCE_DIRECTORY

    @staticmethod
    async def write(file_path, data, target=None):
        Persistence.__initialize()

        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
            with open(file_path, mode) as f:
                f.write(data)

        elif target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blob = Persistence.__bucket.blob(file_path)
            blob.cache_control = "public, max-age=31536000"
            if isinstance(data, (bytes, bytearray)):
                blob.upload_from_string(data)
            else:
                blob.upload_from_string(data.encode())

    @staticmethod
    async def read(file_path, target=None):
        Persistence.__initialize()

        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            with open(file_path, "rb") as f:
                return f.read()

        elif target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blob = Persistence.__bucket.blob(file_path)
            return blob.download_as_bytes()

    @staticmethod
    async def exists(file_path, target=None):
        Persistence.__initialize()

        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            return os.path.exists(file_path)

        elif target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blob = Persistence.__bucket.blob(file_path)
            return blob.exists()

    @staticmethod
    async def delete(file_path, target=None):
        Persistence.__initialize()

        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            os.remove(file_path)

        elif target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blob = Persistence.__bucket.blob(file_path)
            blob.delete()

    @staticmethod
    async def list(prefix, target=None):
        Persistence.__initialize()

        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            file_paths = []
            normalized_prefix = os.path.normpath(prefix)

            if not os.path.exists(normalized_prefix):
                return []

            for directory_root, subdirectories, file_names in os.walk(normalized_prefix):
                for file_name in file_names:
                    file_paths.append(os.path.join(directory_root, file_name))

            return file_paths

        elif target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blobs = Persistence.__bucket.list_blobs(prefix=prefix)
            return [blob.name for blob in blobs]

        return []

    @staticmethod
    async def move(source, source_target=None, destination=None, destination_target=None):
        Persistence.__initialize()

        if source_target is None:
            source_target = Persistence.__default_storage_target

        if destination_target is None:
            destination_target = Persistence.__default_storage_target

        if source_target == StorageTargets.GOOGLE_CLOUD_STORAGE and destination_target == StorageTargets.GOOGLE_CLOUD_STORAGE:
            blob = Persistence.__bucket.blob(source)
            Persistence.__bucket.rename_blob(blob, destination)
        else:
            data = await Persistence.read(source, source_target)
            await Persistence.write(destination, data, destination_target)
            await Persistence.delete(source, source_target)