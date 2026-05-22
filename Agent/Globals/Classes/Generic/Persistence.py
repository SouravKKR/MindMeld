import os

from google.cloud import storage
from google.cloud.storage import Client, Bucket
from Globals.Enumerations.StorageTargets import StorageTargets


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
            credentials_path = os.path.join(
                os.path.dirname(__file__), "..", "..", "..", "..",
                "Common", "Credentials", "mindmeld-storage-2026-249fc22c6610.json"
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