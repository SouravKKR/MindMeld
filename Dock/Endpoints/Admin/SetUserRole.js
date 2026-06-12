const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function setUserRole(request, response)
{
    const body = await request.getBody();
    const targetUserId = body?.userId;
    const roleValue = body?.role;

    if (!targetUserId || roleValue === undefined)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_USER_ID_OR_ROLE" });
        return;
    }

    if (!Object.values(userRoles).includes(roleValue))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "INVALID_ROLE" });
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    const result = await database
        .collection(DatabaseConstants.USERS_COLLECTION)
        .updateOne({ id: targetUserId }, { $set: { role: roleValue } });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
}

module.exports = { setUserRole };
