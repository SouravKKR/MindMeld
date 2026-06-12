# Mirror of Dock/Globals/Classes/Credits/CreditConfigurationStore.js. Loads
# the singleton credit configuration document (creditConfig._id == "global").
# Each Agent subprocess runs a single task, so the short cache mainly avoids a
# second read within the same run (e.g. config consulted at start and again at
# settle).

import time

from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Classes.Credits.CreditConfiguration import CreditConfiguration


class CreditConfigurationStore:

    __DOCUMENT_ID = "global"
    __CACHE_TTL_SECONDS = 15

    __cached_configuration = None
    __cached_at_seconds = 0

    @staticmethod
    async def load() -> CreditConfiguration:
        now = time.time()
        if CreditConfigurationStore.__cached_configuration is not None and (now - CreditConfigurationStore.__cached_at_seconds) < CreditConfigurationStore.__CACHE_TTL_SECONDS:
            return CreditConfigurationStore.__cached_configuration

        database = await DatabaseConnector.get_database()
        if database is None:
            return CreditConfiguration()

        collection = database[DatabaseConstants.CREDIT_CONFIG_COLLECTION]
        document = collection.find_one({"_id": CreditConfigurationStore.__DOCUMENT_ID})

        if document is not None:
            configuration = CreditConfiguration.from_json(document)
        else:
            configuration = CreditConfiguration()
            collection.update_one(
                {"_id": CreditConfigurationStore.__DOCUMENT_ID},
                {"$set": configuration.to_json()},
                upsert=True,
            )

        CreditConfigurationStore.__cached_configuration = configuration
        CreditConfigurationStore.__cached_at_seconds = now
        return configuration
