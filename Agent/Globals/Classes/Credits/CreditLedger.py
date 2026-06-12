# Mirror of Dock/Globals/Classes/Credits/CreditLedger.js. The atomic,
# idempotent charging engine, shared in behaviour with the Dock side so a
# charge issued from the Agent and one issued from Dock are interchangeable.
#
# Idempotency comes from the unique referenceKey index on creditTransactions;
# the balance floor is enforced atomically inside the guarded
# find_one_and_update.

from datetime import datetime, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.CreditTransactionTypes import CreditTransactionTypes
from Globals.Classes.Credits.CreditConfigurationStore import CreditConfigurationStore


class CreditLedger:

    __STATUS_PENDING = "pending"
    __STATUS_APPLIED = "applied"
    __STATUS_REJECTED = "rejected"

    __index_ensured = False

    @staticmethod
    def __ensure_index(transactions_collection) -> None:
        # The unique referenceKey index is the idempotency guard. Dock creates
        # it on boot, but ensure it here too so a charge issued from the Agent
        # is safe even on a fresh database Dock has not touched yet. create_index
        # is idempotent and cheap after the first call.
        if CreditLedger.__index_ensured:
            return
        try:
            transactions_collection.create_index("referenceKey", unique=True)
        except Exception as index_error:
            print(f"[Credits] failed to ensure referenceKey index: {index_error}")
        CreditLedger.__index_ensured = True

    @staticmethod
    def __round(value) -> float:
        try:
            return round(float(value), 4)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    async def charge(user_id: str, amount_credits: float, transaction_type: CreditTransactionTypes, reference_key: str, metadata: dict = None, minimum_balance_floor=None) -> dict:
        """
        Deducts credits for a chargeable subject. Returns a dict describing
        whether the charge applied, was already applied (idempotent replay),
        or was rejected for breaching the balance floor.
        """
        if not user_id or not reference_key:
            return {"applied": False, "already_applied": False, "rejected": False, "amount": 0}

        rounded_amount = CreditLedger.__round(amount_credits)
        if rounded_amount <= 0:
            return {"applied": True, "already_applied": False, "rejected": False, "amount": 0}

        database = await DatabaseConnector.get_database()
        if database is None:
            return {"applied": False, "already_applied": False, "rejected": False, "amount": 0}

        transactions_collection = database[DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION]
        users_collection = database[DatabaseConstants.USERS_COLLECTION]

        CreditLedger.__ensure_index(transactions_collection)

        now = datetime.now(timezone.utc)

        try:
            transactions_collection.insert_one({
                "referenceKey": reference_key,
                "userId": user_id,
                "type": int(transaction_type),
                "amount": -rounded_amount,
                "status": CreditLedger.__STATUS_PENDING,
                "metadata": metadata or {},
                "createdAt": now,
            })
        except DuplicateKeyError:
            existing = transactions_collection.find_one({"referenceKey": reference_key})
            return {
                "applied": existing is not None and existing.get("status") == CreditLedger.__STATUS_APPLIED,
                "already_applied": True,
                "rejected": existing is not None and existing.get("status") == CreditLedger.__STATUS_REJECTED,
                "amount": abs(existing.get("amount", rounded_amount)) if existing is not None else rounded_amount,
            }

        query_filter = {"id": user_id}
        if minimum_balance_floor is not None:
            query_filter["additionalData.credits"] = {"$gte": rounded_amount + minimum_balance_floor}

        updated_document = users_collection.find_one_and_update(
            query_filter,
            {"$inc": {"additionalData.credits": -rounded_amount, "additionalData.lifetimeCreditsSpent": rounded_amount}},
            return_document=ReturnDocument.AFTER,
        )

        if updated_document is None:
            transactions_collection.update_one(
                {"referenceKey": reference_key},
                {"$set": {"status": CreditLedger.__STATUS_REJECTED, "resolvedAt": datetime.now(timezone.utc)}},
            )
            return {"applied": False, "already_applied": False, "rejected": True, "amount": rounded_amount}

        additional_data = updated_document.get("additionalData", {}) or {}
        balance_after = additional_data.get("credits")
        lifetime_spent = additional_data.get("lifetimeCreditsSpent", 0)

        transactions_collection.update_one(
            {"referenceKey": reference_key},
            {"$set": {"status": CreditLedger.__STATUS_APPLIED, "balanceAfter": balance_after, "resolvedAt": datetime.now(timezone.utc)}},
        )

        await CreditLedger.__evaluate_reward_milestones(user_id, lifetime_spent)

        return {"applied": True, "already_applied": False, "rejected": False, "amount": rounded_amount, "balance_after": balance_after}

    @staticmethod
    async def grant(user_id: str, amount_credits: float, transaction_type: CreditTransactionTypes, reference_key: str, metadata: dict = None) -> dict:
        """Grants credits (reward, admin). Idempotent on referenceKey; never blocked."""
        if not user_id or not reference_key:
            return {"applied": False, "already_applied": False, "amount": 0}

        rounded_amount = CreditLedger.__round(amount_credits)
        if rounded_amount <= 0:
            return {"applied": True, "already_applied": False, "amount": 0}

        database = await DatabaseConnector.get_database()
        if database is None:
            return {"applied": False, "already_applied": False, "amount": 0}

        transactions_collection = database[DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION]
        users_collection = database[DatabaseConstants.USERS_COLLECTION]

        CreditLedger.__ensure_index(transactions_collection)

        now = datetime.now(timezone.utc)

        try:
            transactions_collection.insert_one({
                "referenceKey": reference_key,
                "userId": user_id,
                "type": int(transaction_type),
                "amount": rounded_amount,
                "status": CreditLedger.__STATUS_APPLIED,
                "metadata": metadata or {},
                "createdAt": now,
            })
        except DuplicateKeyError:
            return {"applied": False, "already_applied": True, "amount": rounded_amount}

        updated_document = users_collection.find_one_and_update(
            {"id": user_id},
            {"$inc": {"additionalData.credits": rounded_amount}},
            return_document=ReturnDocument.AFTER,
        )

        balance_after = None
        if updated_document is not None:
            balance_after = (updated_document.get("additionalData", {}) or {}).get("credits")

        transactions_collection.update_one(
            {"referenceKey": reference_key},
            {"$set": {"balanceAfter": balance_after, "resolvedAt": datetime.now(timezone.utc)}},
        )

        return {"applied": True, "already_applied": False, "amount": rounded_amount, "balance_after": balance_after}

    @staticmethod
    async def get_balance(user_id: str):
        """Returns the user's current credit balance, or None if unknown."""
        if not user_id:
            return None
        database = await DatabaseConnector.get_database()
        if database is None:
            return None
        users_collection = database[DatabaseConstants.USERS_COLLECTION]
        document = users_collection.find_one({"id": user_id}, {"additionalData.credits": 1})
        if document is None:
            return None
        balance = (document.get("additionalData", {}) or {}).get("credits")
        return balance if isinstance(balance, (int, float)) else None

    @staticmethod
    def __format_threshold(value) -> str:
        # Must match JavaScript's String(number) so the reward referenceKey
        # is identical whether the milestone is granted from the Agent (task
        # charge) or from Dock (storage charge) — otherwise a whole-number
        # threshold would key as "1000" on one side and "1000.0" on the
        # other and the reward could be granted twice.
        numeric = float(value)
        if numeric == int(numeric):
            return str(int(numeric))
        return repr(numeric)

    @staticmethod
    async def __evaluate_reward_milestones(user_id: str, lifetime_credits_spent: float) -> None:
        configuration = await CreditConfigurationStore.load()
        for milestone in configuration.get_reward_milestones():
            if lifetime_credits_spent >= milestone.get_spend_threshold() and milestone.get_reward_credits() > 0:
                threshold_key = CreditLedger.__format_threshold(milestone.get_spend_threshold())
                await CreditLedger.grant(
                    user_id,
                    milestone.get_reward_credits(),
                    CreditTransactionTypes.REWARD_GRANT,
                    f"reward:{user_id}:{threshold_key}",
                    {"spendThreshold": milestone.get_spend_threshold()},
                )
