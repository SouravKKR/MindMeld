import os
import re

import boto3
from botocore.exceptions import ClientError
from Globals.Enumerations.StorageTargets import StorageTargets


class Persistence:
    # Linode Object Storage is S3-compatible. Credentials and endpoint come from
    # the environment (LINODE_STORAGE_BUCKET_ACCESS_KEY / LINODE_STORAGE_BUCKET_SECRET /
    # LINODE_S3_ENDPOINT_HOSTNAMES).
    __LINODE_OBJECT_STORAGE_BUCKET_NAME = "cogniumlearn-bucket"
    __default_storage_target = StorageTargets.LINODE_OBJECT_STORAGE
    __INFORMATION_SOURCE_DIRECTORY = "InformationSources"
    __TASKS_DIRECTORY = "Tasks"

    __linode_object_storage_client = None

    @staticmethod
    def __resolve_linode_endpoint_hostname():
        # The Linode dashboard presents the endpoint as a labelled string such as
        # "IN, Chennai: in-maa-1.linodeobjects.com". Only the bare hostname is
        # meaningful to the S3 client, so it is extracted here.
        raw_endpoint_value = os.getenv("LINODE_S3_ENDPOINT_HOSTNAMES", "")
        hostname_match = re.search(r"[a-z0-9.-]+\.linodeobjects\.com", raw_endpoint_value, re.IGNORECASE)
        return hostname_match.group(0) if hostname_match else raw_endpoint_value.strip()

    @staticmethod
    def __initialize_linode_object_storage():
        if Persistence.__linode_object_storage_client is None:
            endpoint_hostname = Persistence.__resolve_linode_endpoint_hostname()
            # The leading label component of the hostname (e.g. "in-maa-1") doubles as
            # the S3 region used for request signing.
            region_name = endpoint_hostname.split(".")[0]
            Persistence.__linode_object_storage_client = boto3.client(
                "s3",
                endpoint_url=f"https://{endpoint_hostname}",
                region_name=region_name,
                aws_access_key_id=os.getenv("LINODE_STORAGE_BUCKET_ACCESS_KEY"),
                aws_secret_access_key=os.getenv("LINODE_STORAGE_BUCKET_SECRET"),
            )

    @staticmethod
    def get_information_source_directory():
        return Persistence.__INFORMATION_SOURCE_DIRECTORY

    @staticmethod
    async def write(file_path, data, target=None):
        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
            with open(file_path, mode) as file_handle:
                file_handle.write(data)

        elif target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            body = data if isinstance(data, (bytes, bytearray)) else data.encode()
            Persistence.__linode_object_storage_client.put_object(
                Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                Key=file_path,
                Body=body,
                CacheControl="public, max-age=31536000",
            )

    @staticmethod
    async def read(file_path, target=None):
        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            with open(file_path, "rb") as file_handle:
                return file_handle.read()

        elif target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            response = Persistence.__linode_object_storage_client.get_object(
                Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                Key=file_path,
            )
            return response["Body"].read()

    @staticmethod
    async def exists(file_path, target=None):
        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            return os.path.exists(file_path)

        elif target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            try:
                Persistence.__linode_object_storage_client.head_object(
                    Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                    Key=file_path,
                )
                return True
            except ClientError as client_error:
                if client_error.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                    return False
                raise

    @staticmethod
    async def delete(file_path, target=None):
        if target is None:
            target = Persistence.__default_storage_target

        if target == StorageTargets.LOCAL_FILE_SYSTEM:
            os.remove(file_path)

        elif target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            Persistence.__linode_object_storage_client.delete_object(
                Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                Key=file_path,
            )

    @staticmethod
    async def list(prefix, target=None):
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

        elif target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            object_keys = []
            paginator = Persistence.__linode_object_storage_client.get_paginator("list_objects_v2")
            for page in paginator.paginate(
                Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                Prefix=prefix,
            ):
                for stored_object in page.get("Contents", []):
                    object_keys.append(stored_object["Key"])
            return object_keys

        return []

    @staticmethod
    async def move(source, source_target=None, destination=None, destination_target=None):
        if source_target is None:
            source_target = Persistence.__default_storage_target

        if destination_target is None:
            destination_target = Persistence.__default_storage_target

        if source_target == StorageTargets.LINODE_OBJECT_STORAGE and destination_target == StorageTargets.LINODE_OBJECT_STORAGE:
            Persistence.__initialize_linode_object_storage()
            Persistence.__linode_object_storage_client.copy_object(
                Bucket=Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME,
                CopySource={"Bucket": Persistence.__LINODE_OBJECT_STORAGE_BUCKET_NAME, "Key": source},
                Key=destination,
            )
            await Persistence.delete(source, StorageTargets.LINODE_OBJECT_STORAGE)
        else:
            data = await Persistence.read(source, source_target)
            await Persistence.write(destination, data, destination_target)
            await Persistence.delete(source, source_target)
