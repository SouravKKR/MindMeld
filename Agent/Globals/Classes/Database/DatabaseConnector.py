import os
from pymongo import MongoClient
from pymongo.database import Database


class DatabaseConnector:

    __mongo_client: MongoClient = None
    __database: Database        = None
    __b_connected: bool         = False

    @staticmethod
    async def __connect() -> bool:
        try:
            DatabaseConnector.__mongo_client = MongoClient(os.getenv("MONGODB_URL"))

            DatabaseConnector.__database = DatabaseConnector.__mongo_client[os.getenv("MONGODB_DATABASE_NAME")]

            DatabaseConnector.__database.command("ping")

            DatabaseConnector.__b_connected = True

            return True

        except Exception as error:
            print(error)
            print("Failed to connect to MongoDB.")

            DatabaseConnector.__b_connected = False

            return False

    @staticmethod
    def is_connected() -> bool:
        return DatabaseConnector.__b_connected

    @staticmethod
    async def get_database() -> Database:
        if not DatabaseConnector.__b_connected:
            connected = await DatabaseConnector.__connect()

            if not connected:
                return None

        return DatabaseConnector.__database