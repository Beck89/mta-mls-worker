# API Version 2.0

### API Access <a href="#api-access" id="api-access"></a>

To get data, target the odata based Web API like so:

```
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20ModificationTimestamp%20gt%202020-12-30T23:59:59.99Z&$expand=Media,Rooms,UnitTypes
```

With the following header

| Header        | Value                |
| ------------- | -------------------- |
| Authorization | Bearer access\_token |

**Explanation of the URI segments**

The URL shown above has the following segments (with explanations)

| Segment                       | Description                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| <https://api.mlsgrid.com/v2/> | The main location of the API Service for now and the future                          |
| Property                      | The resource name for the data that you want to download                             |
| $filter                       | Using an odata query. This is limited for replication purposes.                      |
| $expand                       | Contains the list of expanded resource types you want included in the returned data. |

All data is compressed using gzip compression to shrink the overall payload size.

#### Limitations of Replication API <a href="#limitations-of-replication-api" id="limitations-of-replication-api"></a>

At this writing there are several limitations imposed on the Web API for the purpose of replication. These limitations are imposed to make the generally heavy odata faster for this specific use case.&#x20;

Here are limitations imposed:

| Limitation                                                                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname)                                  | Each request must contain a single OriginatingSystemName specified in the filter criteria of the request.                                                                                                                                                                                                                                                                                                                                                                                   |
| [Searchable Fields](https://docs.mlsgrid.com/api-documentation/broken-reference) | There are only a few fields you can query the service with. This includes timestamp and status fields. See below for a list of all fields.                                                                                                                                                                                                                                                                                                                                                  |
| $expand calls                                                                    | <p>$expand is limited to specific resources and types due to the custom nature of our API service. Please see the <a href="#resource-naming-1">Expanded Resources</a> section of the docs for more information.  We do not support $select or $orderby on the $expand resources.<br><br><strong>NOTE: If you use expand in the request, the records per request limit reduces to 1000 at most per request. If you set $top=2000 or 5000 for example you will receive an error.</strong></p> |
| 5000 records per request                                                         | You can receive at most 5000 records per request. If you set $top=6000, for example, you will receive an error. The application will default to 500 records per request if not specified.                                                                                                                                                                                                                                                                                                   |
| or operator                                                                      | <p>The query must include no more than 5 'or' operators per query. <br></p><p>NOTE: It is preferred to use the in operator instead which is new in version 2.0.</p>                                                                                                                                                                                                                                                                                                                         |

Otherwise, users can select for specific fields as expected using the $select param in the URL.

### Replication

Here are some examples of how you will use this API for replication. All examples assume the use of the headers being set properly for authentication purposes.

**Initial Import**

This is what the initial import request will look like:

```
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20MlgCanView%20eq%20true
```

The initial import would grab the first "page" of data. We don't want any deleted records so we set MlgCanView to being "equal" to true.&#x20;

#### Next Link

To get the next page of data from the request, as part of the response body you will find a field called @odata.nextLink which contains a url. You can use this url as the next request to page through the data.  You would continue to use the next link to get the next page of data until the response no longer contains a next link.  Here is a snippet that shows what the next link looks like in the json.&#x20;

```
            "MlgCanView": true,
            "ModificationTimestamp": "2019-02-01T00:55:41.516Z",
            "OriginatingSystemName": "actris"
        }
    ],
    "@odata.nextLink": "https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20'actris'%20and%20MlgCanView%20eq%20true&$expand=Media%2CRooms%2CUnitTypes&$top=1000&$skip=4000"
}
```

**Errors during import**

If you encounter an error during your initial import you can avoid re-downloading any records that you already received and continue where you left off by adding the ModificationTimestamp that you last received to the initial import query:

```
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20MlgCanView%20eq%20true%20and%20ModificationTimestamp%20gt%202020-12-12T00:00:00.000Z&$expand=Media,Rooms,UnitTypes
```

We order our requests by ModificationTimestamp by default so that you do not miss changes that occur during your download and so that you can pick up where you left off in this manner.&#x20;

**After Initial Import**

After you have the initial data fully downloaded, you would switch to using replication queries which do not contain an MlgCanView filter in them. This allows you to get all changes to the data including changes to MlgCanView=false so that you know when data is removed from the feed and needs to be deleted from your local data store. If you choose to store only a subset of the data in your local data store, your replication queries need to contain the greatest ModificationTimestamp you have received in the data from the api regardless of whether or not you choose to store the records you receive.  This avoids repulling the same data over and over again.&#x20;

Here is an example replication query:

```
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20ModificationTimestamp%20gt%202019-02-04T23:59:59.99Z&$expand=Media,Rooms,UnitTypes
```

This should be very familiar to anyone who has used RETS before and needed to replicate over that service.

### Signal Fields

The following fields when they have changed indicate that action must be taken by the consumer with regard to their local data store.&#x20;

| Resource or Expanded Resource | Field                      | Action to Take                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALL                           | ModificationTimestamp      | The record data has changed, replace the contents of your local copy of the record with the updated copy received during replication.                                                                                                                                                                                                                                                                                                                |
| ALL                           | MlgCanView                 | When changed to false, the record is no longer valid for the feed type you consume and must be removed from your local data store.                                                                                                                                                                                                                                                                                                                   |
| Property, Member, Office      | PhotosChangeTimestamp      | This value will not change without also having the ModificationTimestamp change. If this timestamp changes, it means that the media records have changed. Replace the contents of your local copy of any media records with the updated copies received during replication.  Pay attention to any MediaModificationTimestamp updates as noted below.                                                                                                 |
| Media                         | MediaModificationTimestamp | This value exists on the Media subdocuments of a Property, Member, or Office record. None of these values will change without also having the ModificationTimestamp of the Property, Member, or Office record change. During regular replication, if the MediaModificationTimestamp of a media record is new or different from what you had before, the image file has changed and needs to be re-downloaded using the MediaURL of the media record. |

Here is an example of a typical sequence of events for how to use these signal fields when receiving updates to records.&#x20;

1. Query the API for updates using the greatest ModificationTimestamp from your local database for this resource.&#x20;
2. While saving each record received, take the following steps:&#x20;
3. Look to see if the MlgCanView field is false.  If it is, delete or mark your local data copy to be deleted from your data set.&#x20;
4. Look to see if the PhotosChangeTimestamp has changed since the last time you received this record. If it has changed, then replace your local media records with the ones you've received in the update.&#x20;
5. The key of the Media record is the MediaKey. Match up your records by the MediaKey. If you received a new MediaKey, or a MediaKey you did not previously have, download that image using the MediaURL.
6. If the MediaKey no longer exists mark that record deleted.&#x20;
7. After taking all needed action, save off the ModificationTimestamp as the greatest ModificationTimestamp you have received back from the API for this resource and then repeat for the next record.&#x20;

### Metadata

Use this endpoint to access the metadata for the API.

```
https://api.mlsgrid.com/v2/$metadata?$filter=OriginatingSystemName%20eq%20%27actris%27
```

### Resource Naming <a href="#resource-naming" id="resource-naming"></a>

The following is a list of the resource names (or entity sets) to use in the request URL.

| Resource Endpoint | Expandable Resources                       | Description                                                               |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Property          | <p>Media,</p><p>Rooms,</p><p>UnitTypes</p> | Property Resource. This resource contains all listings for sale or lease. |
| Member            | Media                                      | Member Resource                                                           |
| Office            | Media                                      | Office Resource                                                           |
| OpenHouse         | -                                          | OpenHouse Resource                                                        |
| Lookup            | -                                          | Lookup Resource                                                           |

### Expanded Resources <a href="#resource-naming" id="resource-naming"></a>

The expanded resources are a sub document of the resource that they belong to. For example the Media records exist as an array of records called Media on the Property Record and are given through the api as part of the Property record.  If the ModificationTimestamp of the Property record changes, the contents of the Media sub document should be replaced by whatever is returned in the updated record.

The following is a list of the expandable resources and their corresponding [Resource Names](#resource-naming) that have the ability to expand them. This is basically the same list as above but inverted:

| Expanded Resource Name | Resources that can expand this resource     | Description                                                                                                |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Media                  | <p>Property,</p><p>Member,</p><p>Office</p> | Media expandable resource. These are the media files associated with a Property, Member, or Office record. |
| Rooms                  | Property                                    | Rooms expandable resource. These are the Room records associated with a Property record.                   |
| UnitTypes              | Property                                    | UnitTypes expandable resource. These are the UnitType records associated with a Property record.           |

### Rooms and UnitTypes

RESO expects these expanded collections to be named differently on the records they are expanded onto.  These collections are referenced in the nav links in the resource metadata.  This is how the requests and data look:

#### Metadata

The field name of the data in the Property or other resource record will match the name in the nav link located in the resource it expands from.  The Type of the nav link will indicate what EntityType that field name corresponds to so that you can find the definition for that expanded type in the metadata.

Example Metadata Nav Links:&#x20;

```
<NavigationProperty Name="Rooms" Type="Collection(org.reso.metadata.PropertyRooms)"/>
<NavigationProperty Name="UnitTypes" Type="Collection(org.reso.metadata.PropertyUnitTypes)"/>
```

#### Example Expand Request:&#x20;

```
https://api-demo.mlsgrid.com/v2/Property?$expand=Rooms,UnitTypes,Media&$filter=OriginatingSystemName eq 'actris'
```

#### Example Rooms Expanded Data:&#x20;

```
"Rooms": [
        {
            "RoomDimensions": "13X14",
            "RoomType": "Bedroom 1",
            "RoomFeatures": "Full Bath",
            "RoomKey": "RTC1733786Group_1"
        },
        {
            "RoomDimensions": "12X11",
            "RoomType": "Bedroom 2",
            "RoomKey": "RTC1733786Group_2"
        }        
    ],
```

#### Example UnitTypes Expanded Data:

```
"UnitTypes": [
                {
                    "UnitTypeActualRent": 1,
                    "UnitTypeType": "Unit 1",
                    "UnitTypeBathsTotal": 1,
                    "UnitTypeBedsTotal": 2,
                    "UnitTypeKey": "RTC2405117Group_1"
                },
                {
                    "UnitTypeActualRent": 1,
                    "UnitTypeType": "Unit 2",
                    "UnitTypeBathsTotal": 1,
                    "UnitTypeBedsTotal": 2,
                    "UnitTypeKey": "RTC2405117Group_2"
                }
            ]
```

### Deleted Records

**MlgCanView - Deleted Listings, Off Market Listings, Etc**

Each record in the system has a field called MlgCanView which is a boolean field and indicates whether the record should be kept in your database or not. This is how we have implemented our delete mechanism. When you receive an updated record during replication, you should first check this flag to see what action to take with your local copy of the record.&#x20;

* IF **true**, then save or update the existing record in your db.
* IF **false**, then remove the record from your database (or never save it in the first place).

This value can be changed to false based on a number of different reasons. \
The following are a few example reasons: &#x20;

* The property was deleted.
* The property listing office decided that they don't want to feed out any of their listings.
* The property changed status and made it unavailable in IDX
* Etc.

***PLEASE NOTE: After 7 days records marked MlgCanView false will be removed from the data feed entirely.***

The MlgCanView field is a specific field to the MLS Grid that tells you whether the record should be kept in your database. (note that any field with the prefix "Mlg" is specific to the Grid)

### Deleted Expanded Resource Records

There is no delete flag for expanded resources as they exist as a part of the record they come with. As is the case with all other fields on the record, if you get records or values that are different than what you currently have, replace it with the new records and values you've received. If some of the data in your local data store no longer exists in the updated data that you received, remove it.&#x20;

### MlgCanUse Field

Each record in the system has a field called MlgCanUse which is an array that helps indicate which of the Use Cases defined in the MLS Grid Master Data License Agreement the record qualifies for.

Each of the values in this field correspond to the data subscription types where the record may be found, and the possible Use Cases for each data subscription type are detailed below.

#### IDX Data Subscriptions

Records marked for IDX can be used in the Internet Data Exchange Program for public display on IDX websites AND in Customer Relationship Management and Transaction management tools.

#### Example MlgCanUse Field Output for IDX

```
"MlgCanUse": [
    "IDX"
]
```

#### VOW Data Subscriptions

Records marked for VOW can be used in the Virtual Office Website Program whereby a Internet website or a feature of a website is capable of providing real estate brokerage services to consumers where there exists a broker-consumer relationship. Additionally if the MlgCanUse field contains the IDX value, the records can also be used for the IDX Use Cases detailed above. Records that contain ONLY the VOW value can not be used for IDX Use Cases.

#### Example MlgCanUse Field Output for VOW

```
"MlgCanUse": [
    "VOW"
]
```

```
"MlgCanUse": [
    "IDX",
    "VOW"
]
```

#### Back Office (BO) Data Subscriptions

Records marked for Back Office (BO) can be used in Agent Production Analytics, Comparative Market Analysis, Real Estate Market Analytics, and Participant Listings Use (as each is defined in the MLS Grid Master Data License Agreement). Additionally if the MlgCanUse field contains the IDX and VOW values, the records can also be used for the IDX and VOW Use Cases detailed above. Records that contain ONLY the BO value can not be used for IDX or VOW Use Cases.

#### Example MlgCanUse Field Output for Back Office (BO)

```
"MlgCanUse": [
    "BO"
]
```

```
"MlgCanUse": [
    "VOW",
    "BO"
]
```

```
"MlgCanUse": [
    "IDX",
    "VOW",
    "BO"
]
```

#### Broker Only / Participant Data Access (PT) Data Subscriptions&#x20;

Records marked for Broker Only / Participant Data Access (PT) can be used solely for Participant Listings Use (as defined in the MLS Grid Master Data License Agreement).

#### Example MlgCanUse Field Output for Broker Only / Participant Data Access (PT)

```
"MlgCanUse": [
    "PT"
]
```

#### Example MlgCanUse Field Metadata

The MlgCanUse field can be found in the MLS Grid Metadata for each MLS.

```
<Property Name="MlgCanUse" Type="Collection(Edm.String)" >
     <Annotation Term="MLS.OData.Metadata.MLSGRID" String="Allowed use case groups"/>
     <Annotation String="https://docs.mlsgrid.com/api-documentation/api-version-2.0#mlgcanuse-field" Term="MLSGRID.Docs"/>
 </Property>
```

### Media

The expanded media contains data describing photos associated with Properties, Members, and Offices.

The primary identifier of the media records is the MediaKey field.  This is the field that uniquely identifies a record.

In order to retrieve the photo associated with the media record, you will need to use the url provided in the MediaURL field to download the image. The url is for the highest resolution photo that the MLS provides to us.The URLs contained in the Media resource are to be used ONLY for the purpose of downloading a local copy of the image file. DO NOT use these URLs on your website or in your application.

### Lookups

This resource contains all of the lookup values for an mls. We recommend using the following queries to replicate and keep your Lookup data up to date:

#### Initial Data Import Request

```
https://api.mlsgrid.com/v2/Lookup?$filter=OriginatingSystemName eq ‘actris’ and MlgCanView eq true
```

#### Regular Replication Requests

```
https://api.mlsgrid.com/v2/Lookup?$filter=OriginatingSystemName eq ‘actris’ and ModificationTimestamp gt [GREATEST ModificationTimestamp FROM YOUR DATABASE FOR THIS RESOURCE]
```

Replicate from this resource the same way you would replicate from any of the resources using the Greatest ModificationTimestamp from the records you've received so far when querying for the latest changes.&#x20;

Please do not pull from this resource more frequently than once a day as this resource will not likely change more than once a day. Pulling this resource with the same frequency as the rest of the resources may result in interruption of service for inefficient usage practices.

If you receive an update to MlgCanView: false on any of your lookup records, you should remove it from the list of possible values for that LookupName for the OriginatingSystemName on the record.

#### Example Lookup Record

The LookupKey is the primary identifier for this resource. Each record indicates that a lookup exists and is being used or not used by a particular mls depending on the value of the MlgCanView flag. The ModificationTimestamp will update whenever the Lookup record has changed.

```
{
    "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb678f24b9e68b94c1734e')",
    "LookupKey": "ACT61bb678f24b9e68b94c1734e",
    "LookupName": "AreaUnits",
    "LookupValue": "Square Meters",
    "ModificationTimestamp": "2021-12-16T16:21:35.529Z",
    "OriginatingSystemName": "actris",
    "StandardLookupValue": "Square Meters",
    "MlgCanView": true
}
```

#### Example Field Metadata with a Lookup:&#x20;

Fields that have a lookup collection associated to it will appear like this in the metadata. In these 2 cases, the BodyType field uses a Lookup with the LookupName of BodyType in the Lookups collection. Possible values for this field can be found by looking in your local copy of the Lookups data for values assocated to the BodyType lookup. Same For StandardStatus.  Lookup values for StandardStatus have a LookupName of StandardStatus in the lookups collection and you can search your local copy of the lookups collection for values associated with the StandardStatus Lookup.&#x20;

```
<Property Name="BodyType" Type="Collection(Edm.String)">
    <Annotation Term="MLS.OData.Metadata.LookupName" String="BodyType"/>
</Property>
...
<Property Name="StandardStatus" Type="Edm.String">
    <Annotation Term="MLS.OData.Metadata.LookupName" String="StandardStatus"/>

```

#### Example of These 2 Lookups from the Lookups Resource:

BodyType

```
https://api-demo.mlsgrid.com/v2/Lookup?$filter=LookupName eq 'BodyType' and OriginatingSystemName eq 'mfrmls'

{
    "@odata.context": "https://api-demo.mlsgrid.com/v2/$metadata#Lookup",
    "value": [
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('MFR61bb678f24b9e68b94c1768e')",
            "LookupKey": "MFR61bb678f24b9e68b94c1768e",
            "LookupName": "BodyType",
            "LookupValue": "Double Wide",
            "ModificationTimestamp": "2021-12-16T16:21:35.843Z",
            "OriginatingSystemName": "mfrmls",
            "StandardLookupValue": "Double Wide",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('MFR61bb679024b9e68b94c178dd')",
            "LookupKey": "MFR61bb679024b9e68b94c178dd",
            "LookupName": "BodyType",
            "LookupValue": "Single Wide",
            "ModificationTimestamp": "2021-12-16T16:21:36.083Z",
            "OriginatingSystemName": "mfrmls",
            "StandardLookupValue": "Single Wide",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('MFR61bb679024b9e68b94c179c3')",
            "LookupKey": "MFR61bb679024b9e68b94c179c3",
            "LookupName": "BodyType",
            "LookupValue": "Triple Wide",
            "ModificationTimestamp": "2021-12-16T16:21:36.163Z",
            "OriginatingSystemName": "mfrmls",
            "StandardLookupValue": "Triple Wide",
            "MlgCanView": true
        }
    ]
} 
```

StandardStatus

```
https://api-demo.mlsgrid.com/v2/Lookup?$filter=LookupName eq 'StandardStatus' and OriginatingSystemName eq 'actris'

{
    "@odata.context": "https://api-demo.mlsgrid.com/v2/$metadata#Lookup",
    "value": [
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679024b9e68b94c17bf8')",
            "LookupKey": "ACT61bb679024b9e68b94c17bf8",
            "LookupName": "StandardStatus",
            "LookupValue": "Canceled",
            "ModificationTimestamp": "2021-12-16T16:21:36.393Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Canceled",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c180c1')",
            "LookupKey": "ACT61bb679124b9e68b94c180c1",
            "LookupName": "StandardStatus",
            "LookupValue": "Expired",
            "ModificationTimestamp": "2021-12-16T16:21:37.056Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Expired",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c181b8')",
            "LookupKey": "ACT61bb679124b9e68b94c181b8",
            "LookupName": "StandardStatus",
            "LookupValue": "Delete",
            "ModificationTimestamp": "2021-12-16T16:21:37.135Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Delete",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c181bf')",
            "LookupKey": "ACT61bb679124b9e68b94c181bf",
            "LookupName": "StandardStatus",
            "LookupValue": "Withdrawn",
            "ModificationTimestamp": "2021-12-16T16:21:37.135Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Withdrawn",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c18331')",
            "LookupKey": "ACT61bb679124b9e68b94c18331",
            "LookupName": "StandardStatus",
            "LookupValue": "Pending",
            "ModificationTimestamp": "2021-12-16T16:21:37.286Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Pending",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c1869e')",
            "LookupKey": "ACT61bb679124b9e68b94c1869e",
            "LookupName": "StandardStatus",
            "LookupValue": "Incomplete",
            "ModificationTimestamp": "2021-12-16T16:21:37.588Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Incomplete",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c187ef')",
            "LookupKey": "ACT61bb679124b9e68b94c187ef",
            "LookupName": "StandardStatus",
            "LookupValue": "Active",
            "ModificationTimestamp": "2021-12-16T16:21:37.738Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Active",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679124b9e68b94c18a63')",
            "LookupKey": "ACT61bb679124b9e68b94c18a63",
            "LookupName": "StandardStatus",
            "LookupValue": "Coming Soon",
            "ModificationTimestamp": "2021-12-16T16:21:37.965Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Coming Soon",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679224b9e68b94c18c1d')",
            "LookupKey": "ACT61bb679224b9e68b94c18c1d",
            "LookupName": "StandardStatus",
            "LookupValue": "Active Under Contract",
            "ModificationTimestamp": "2021-12-16T16:21:38.122Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Active Under Contract",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679924b9e68b94c1c8c1')",
            "LookupKey": "ACT61bb679924b9e68b94c1c8c1",
            "LookupName": "StandardStatus",
            "LookupValue": "Hold",
            "ModificationTimestamp": "2021-12-16T16:21:45.259Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Hold",
            "MlgCanView": true
        },
        {
            "@odata.id": "https://api-demo.mlsgrid.com/v2/Lookup('ACT61bb679924b9e68b94c1ca2d')",
            "LookupKey": "ACT61bb679924b9e68b94c1ca2d",
            "LookupName": "StandardStatus",
            "LookupValue": "Closed",
            "ModificationTimestamp": "2021-12-16T16:21:45.412Z",
            "OriginatingSystemName": "actris",
            "StandardLookupValue": "Closed",
            "MlgCanView": true
        }
    ]
}  

```

### Searchable Fields <a href="#searchable-fields" id="searchable-fields"></a>

To keep performance as optimal as possible, we restrict searching on our replication odata server to the fields that are required for replication consumers. The tables below detail those fields.

#### Property

<table data-header-hidden><thead><tr><th width="227.49700064387622">Searchable Property Field</th><th>Description</th></tr></thead><tbody><tr><td>Searchable Property Field</td><td>Description</td></tr><tr><td><a href="#originatingsystemname">OriginatingSystemName</a></td><td>This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System.</td></tr><tr><td>ModificationTimestamp</td><td>The timestamp that the record was last modified by the MLS Grid.</td></tr><tr><td><a href="#standardstatus">StandardStatus</a></td><td>The standard status field (values are 'active', 'closed', etc)</td></tr><tr><td><a href="https://docs.mlsgrid.com/api-documentation/api-version-2.0#propertytype">PropertyType</a></td><td>The property type field (values are 'Residential','CommercialSale', etc)</td></tr><tr><td>ListingId</td><td>The <a href="#prefixed-keyfield-values">prefixed MLS id</a> of the listing record. </td></tr><tr><td><a href="#deleted-records">MlgCanView</a></td><td>Whether or not the record is allowed to be included in the feed type you are requesting.</td></tr><tr><td>ListOfficeMlsId</td><td>The <a href="#prefixed-keyfield-values">prefixed MLS id</a> of the office record that the record was listed by.</td></tr></tbody></table>

#### Member

<table data-header-hidden><thead><tr><th width="264.9593779560839">Searchable Member Field</th><th>Description</th></tr></thead><tbody><tr><td>Searchable Member Field</td><td>Description</td></tr><tr><td><a href="#originatingsystemname">OriginatingSystemName</a></td><td>This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System.</td></tr><tr><td>ModificationTimestamp</td><td>The timestamp that the record was last modified by the MLS Grid.</td></tr><tr><td>MemberMlsId</td><td>The <a href="#prefixed-keyfield-values">prefixed MLS id</a> of the member record. </td></tr><tr><td><a href="#deleted-records">MlgCanView</a></td><td>Whether or not the record is allowed to be included in the feed type you are requesting.</td></tr></tbody></table>

#### Office

| Searchable Office Field                         | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| OfficeMlsId                                     | The [prefixed MLS id](#prefixed-keyfield-values) of the office record.                                                                        |
| [MlgCanView](#deleted-records)                  | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |

#### OpenHouse

| Searchable OpenHouse Field                      | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| OpenHouseKey                                    | The [prefixed MLS key](#prefixed-keyfield-values) of the open house record.                                                                   |
| ListingId                                       | The [prefixed MLS id](#prefixed-keyfield-values) of the property record associated with the open house record.                                |
| MlgCanView                                      | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |
| OpenHouseDate                                   | The date that the open house will take place.                                                                                                 |

#### Lookup

<table data-header-hidden><thead><tr><th width="268.5748140922941">Searchable Lookup Field</th><th>Description</th></tr></thead><tbody><tr><td>Searchable Lookup Field</td><td>Description</td></tr><tr><td><a href="#originatingsystemname">OriginatingSystemName</a></td><td>This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System.</td></tr><tr><td>ModificationTimestamp</td><td>The timestamp that the record was last modified by the MLS Grid.</td></tr><tr><td>LookupName</td><td>The name of the Lookup you want to get the records for.</td></tr><tr><td><a href="#deleted-records">MlgCanView</a></td><td>Whether or not the record is still being used by the OriginatingSystem.</td></tr></tbody></table>

### Broker Only Searchable Fields <a href="#searchable-fields" id="searchable-fields"></a>

Broker Only Export feed has a more restricted set of fields that can be searched. The following fields are minimal for the purposes of replicating the records for this feed type.&#x20;

#### Property

| Searchable Property Field                       | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| ListOfficeMlsId                                 | The [prefixed MLS id](#prefixed-keyfield-values) of the office record that the record was listed by.                                          |
| [MlgCanView](#deleted-records)                  | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |

#### Member

| Searchable Member Field                         | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| OfficeMlsId                                     | The [prefixed MLS id](#prefixed-keyfield-values) of the office associated with the member record.                                             |
| [MlgCanView](#deleted-records)                  | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |

#### Office

| Searchable Office Field                         | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| OfficeMlsId                                     | The [prefixed MLS id](#prefixed-keyfield-values) of the office record.                                                                        |
| [MlgCanView](#deleted-records)                  | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |

#### OpenHouse

| Searchable OpenHouse Field                      | Description                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [OriginatingSystemName](#originatingsystemname) | This field is a required search field on every request in version 2.0 of the API. This field is the MLS Grid name for the Originating System. |
| ModificationTimestamp                           | The timestamp that the record was last modified by the MLS Grid.                                                                              |
| ListOfficeMlsId                                 | The [prefixed MLS id](#prefixed-keyfield-values) of the office record of the listing record associated with the open house record.            |
| MlgCanView                                      | Whether or not the record is allowed to be included in the feed type you are requesting.                                                      |

### OriginatingSystemName

The OriginatingSystemField is a field we use to indicate which system a record has originated from.  The values in this field are case sensitive and usually all lowercase. The possible values for OriginatingSystemName are as follows:  &#x20;

| OriginatingSystemName | Originating System                                       |
| --------------------- | -------------------------------------------------------- |
| actris                | ACTRIS MLS                                               |
| carolina              | Canopy MLS                                               |
| eciar                 | East Central Iowa Multiple Listing Service Inc.          |
| flinthills            | Flint Hills MLS                                          |
| scranton              | Greater Scranton Board of REALTORS®                      |
| nira                  | Northwest Indiana REALTORS® Association (formerly GNIAR) |
| hmls                  | Heartland Multiple Listing Service, Inc.                 |
| highland              | Highland Lakes Association of REALTORS®                  |
| ires                  | IRES MLS                                                 |
| lbor                  | Lawrence Board of REALTORS®                              |
| lsar                  | Lake Superior Area REALTORS®                             |
| lascruces             | Southern New Mexico MLS                                  |
| maris2                | MARIS MLS (NEW)                                          |
| mfrmls                | My Florida Regional MLS DBA Stellar MLS                  |
| mibor                 | MIBOR REALTOR® Association                               |
| mlsok                 | MLSOK                                                    |
| mred                  | MRED Midwest Real Estate Data                            |
| neirbr                | Northeast Iowa Regional Board of REALTORS®               |
| nocoast               | NoCoast MLS                                              |
| northstar             | NorthstarMLS®                                            |
| nwmls                 | Northwest MLS                                            |
| onekey2               | OneKey® MLS                                              |
| paar                  | Prescott Area Association of REALTORS®                   |
| pikewayne             | Pike/Wayne Association of REALTORS®                      |
| prairie               | Mid-Kansas MLS (Prairie Land REALTORS®)                  |
| ranw                  | REALTOR® Association Northeast Wisconsin                 |
| realtrac              | RT RealTracs                                             |
| recolorado            | REcolorado                                               |
| rmlsa                 | RMLS Alliance                                            |
| rrar                  | Reelfoot Regional Association of REALTORS®               |
| sarmls                | Spokane Association of REALTORS®                         |
| sckansas              | South Central Kansas MLS                                 |
| somo                  | Southern Missouri Regional MLS (SOMO)                    |
| spartanburg           | Spartanburg Board of REALTORS®                           |
| sunflower             | Sunflower MLS                                            |

### Searchable Fields with Lookups

The PropertyType and StandardStatus fields are defined in the Lookups collection.  You can search by the lookup value for these fields when performing a request.

Example Query by StandardStatus Request:

```
https://api-demo.mlsgrid.com/v2/Property?$filter=StandardStatus eq 'Active Under Contract' and OriginatingSystemName eq 'actris'
```

### StandardStatus

Querying by the StandardStatus field is a special case because it is enumerated.  The following example shows the syntax needed.&#x20;

To get all of the records that have an Active Under Contract StandardStatus, you must use the name of the status in order to query for it. (Note that in the table below the name is 'ActiveUnderContract' without spaces. These names are also contained in the StandardStatus enumeration metadata in the API but are provided here for convenience).&#x20;

This is the syntax for a request for all records with an Active Under Contract StandardStatus value:&#x20;

```
// Query by the name
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20StandardStatus+eq+%27Active%20Under%20Contract%27
```

The following are the RESO Standard Status values we provide:&#x20;

| Name                | Value | Standard Name         |
| ------------------- | ----- | --------------------- |
| Active              | 1     | Active                |
| ActiveUnderContract | 2     | Active Under Contract |
| Canceled            | 3     | Canceled              |
| Closed              | 4     | Closed                |
| ComingSoon          | 5     | Coming Soon           |
| Delete              | 6     | Delete                |
| Expired             | 7     | Expired               |
| Hold                | 8     | Hold                  |
| Incomplete          | 9     | Incomplete            |
| Pending             | 10    | Pending               |
| Withdrawn           | 11    | Withdrawn             |

### PropertyType

Querying by the PropertyType field is a special case because it is enumerated.  The following example shows the syntax needed.&#x20;

To get all of the records that have a PropertyType value of 'Commercial Sale', you must use the name of the PropertyType in order to query for it. (Note that in the table below the name is 'CommercialSale' without spaces. These names are also contained in the PropertyType enumeration metadata in the API but are provided here for convenience).&#x20;

This is the syntax for a request for all records with a Commercial Sale PropertyType value:&#x20;

```
// Query by the name
https://api.mlsgrid.com/v2/Property?$filter=OriginatingSystemName%20eq%20%27actris%27%20and%20PropertyType+eq+%27Commercial%20Sale%27
```

The following are the RESO Property Type values we provide:&#x20;

| Name                | Value | Standard Name        |
| ------------------- | ----- | -------------------- |
| BusinessOpportunity | 1     | Business Opportunity |
| CommercialLease     | 2     | Commercial Lease     |
| Commercial Sale     | 3     | Commercial Sale      |
| Farm                | 4     | Farm                 |
| Land                | 5     | Land                 |
| ManufacturedInPark  | 6     | Manufactured In Park |
| Residential         | 7     | Residential          |
| ResidentialIncome   | 8     | Residential Income   |
| ResidentialLease    | 9     | Residential Lease    |

### Local Fields Prefix

Local fields specific to an MLS have been prefixed to identify which MLS they originate from. The local field prefixes are:&#x20;

| Local Field Prefix | Originating System                                       |
| ------------------ | -------------------------------------------------------- |
| ACT\_              | ACTRIS MLS                                               |
| CAR\_              | Canopy MLS                                               |
| ECR\_              | East Central Iowa Multiple Listing Service Inc.          |
| FHR\_              | Flint Hills MLS                                          |
| GSB\_              | Greater Scranton Board of REALTORS®                      |
| NRA\_              | Northwest Indiana REALTORS® Association (formerly GNIAR) |
| HMS\_              | Heartland Multiple Listing Service, Inc.                 |
| HLM\_              | Highland Lakes Association of REALTORS®                  |
| IRE\_              | IRES MLS                                                 |
| LCN\_              | Southern New Mexico MLS                                  |
| LBR\_              | Lawrence Board of REALTORS®                              |
| LSA\_              | Lake Superior Area REALTORS®                             |
| MIS\_              | MARIS MLS (NEW)                                          |
| MBR\_              | MIBOR REALTOR® Association                               |
| MFR\_              | My Florida Regional MLS DBA Stellar MLS                  |
| MRD\_              | MRED Midwest Real Estate Data                            |
| NBR\_              | Northeast Iowa Regional Board of REALTORS®               |
| NOC\_              | NoCoast MLS                                              |
| NST\_              | NorthstarMLS®                                            |
| NWM\_              | Northwest MLS                                            |
| OKC\_              | MLSOK                                                    |
| KEY\_              | OneKey® MLS                                              |
| PAR\_              | Prescott Area Association of REALTORS®                   |
| PWB\_              | Pike/Wayne Association of REALTORS®                      |
| PRA\_              | Mid-Kansas MLS (Prairie Land REALTORS®)                  |
| RAN\_              | REALTOR® Association Northeast Wisconsin                 |
| REC\_              | REcolorado                                               |
| RMA\_              | RMLS Alliance                                            |
| RRA\_              | Reelfoot Regional Association of REALTORS®               |
| RTC\_              | RT RealTracs                                             |
| SAR\_              | Spokane Association of REALTORS®                         |
| SCK\_              | South Central Kansas MLS                                 |
| SOM\_              | Southern Missouri Regional MLS (SOMO)                    |
| SPN\_              | Spartanburg Board of REALTORS®                           |
| SUN\_              | Sunflower MLS                                            |

### Prefixed KeyField Values

In order to maintain uniqueness across IDs, it is necessary to prefix our Key and MlsId fields throughout the data.  Any field that is a Key or an MlsId field or is a reference to a Key or MlsId field in one of our other resources will be prefixed with an MLS specific prefix.  This prefix **should** be removed from the data prior to displaying externally but must be added back whenever requesting records within the MLS Grid. &#x20;

Here are a few examples:&#x20;

If my ListingKey for a record in the MLS system was '123456' and my MLS's prefix was 'ACT', I would search in the MLS Grid for a record with a ListingKey equal to 'ACT123456'.  If I wanted to display this record on my website, I would display '123456' as the key on my website. &#x20;

If I have a problem with the OpenHouse records for one of my properties and I need to troubleshoot this specific record I might search for OpenHouse records by the MlsId of the property record. To find open house records for a property record, if the MlsId for the MLS's property record was '456789' and the MLS's prefix was 'ACT', I would search the OpenHouse resource for records where the ListingId is equal to 'ACT456789'. &#x20;

Finally, if I wanted to find the Member record in the MLS Grid for an MLS's property record with a ListAgentMlsId of 'A10001', I would search the Member resource for the MemberMlsId equal to 'ACTA10001'. If I also search for the Property record from the MLS Grid, I can expect that the ListAgentMlsId in the data would be equal to 'ACTA10001' which would match the MemberMlsId of the Member resource record I received.

***PLEASE NOTE: Non-Alphanumeric characters can create issues with oData and the RESO Web API. For this purpose special characters must be stripped from the values provided in key fields.***

The following are the Key and MlsId prefixes for each MLS source:&#x20;

| KeyField Prefix | Originating System                                       |
| --------------- | -------------------------------------------------------- |
| ACT             | ACTRIS MLS                                               |
| CAR             | Canopy MLS                                               |
| ECR             | East Central Iowa Multiple Listing Service Inc.          |
| FHR             | Flint Hills MLS                                          |
| GSB             | Greater Scranton Board of REALTORS®                      |
| NRA             | Northwest Indiana REALTORS® Association (formerly GNIAR) |
| HMS             | Heartland Multiple Listing Service, Inc.                 |
| HLM             | Highland Lakes Association of REALTORS®                  |
| IRE             | IRES MLS                                                 |
| LCN             | Southern New Mexico MLS                                  |
| LBR             | Lawrence Board of REALTORS®                              |
| LSA             | Lake Superior Area REALTORS®                             |
| MIS             | MARIS MLS (NEW)                                          |
| MBR             | MIBOR REALTOR® Association                               |
| MFR             | My Florida Regional MLS DBA Stellar MLS                  |
| MRD             | MRED Midwest Real Estate Data                            |
| NBR             | Northeast Iowa Regional Board of REALTORS®               |
| NOC             | NoCoast MLS                                              |
| NST             | NorthstarMLS®                                            |
| NWM             | Northwest MLS                                            |
| OKC             | MLSOK                                                    |
| KEY             | OneKey® MLS                                              |
| PAR             | Prescott Area Association of REALTORS®                   |
| PWB             | Pike/Wayne Association of REALTORS®                      |
| PRA             | Mid-Kansas MLS (Prairie Land REALTORS®)                  |
| RAN             | REALTOR® Association Northeast Wisconsin                 |
| REC             | REcolorado                                               |
| RMA             | RMLS Alliance                                            |
| RRA             | Reelfoot Regional Association of REALTORS®               |
| RTC             | RT RealTracs                                             |
| SAR             | Spokane Association of REALTORS®                         |
| SCK             | South Central Kansas MLS                                 |
| SOM             | Southern Missouri Regional MLS (SOMO)                    |
| SPN             | Spartanburg Board of REALTORS®                           |
| SUN             | Sunflower MLS                                            |

### Array of Strings

RESO expects fields defined as type 'String List, Multi' to be returned as an array of strings.  We output these fields as an array of multiple string values. &#x20;

Example field output

```
"Appliances": [
                "Washer Dryer Hookup",
                "Dishwasher",
                "Oven",
                "Refrigerator"
            ],
            
```

At the time of this documentation, these are the fields that we have in our data that are of type 'String List, Multi'.  To get a complete list, please use [RESO's documentation](https://docs.google.com/spreadsheets/d/1SZ0b6T4_lz6ti6qB2Je7NSz_9iNOaV_v9dbfhPwWgXA/edit#gid=799978943).&#x20;

#### Property

| AccessibilityFeatures         |
| ----------------------------- |
| Appliances                    |
| ArchitecturalStyle            |
| AssociationAmenities          |
| AssociationFeeIncludes        |
| Basement                      |
| BodyType                      |
| BuildingFeatures              |
| BusinessType                  |
| BuyerAgentDesignation         |
| BuyerFinancing                |
| CoBuyerAgentDesignation       |
| CoListAgentDesignation        |
| CommonWalls                   |
| CommunityFeatures             |
| ConstructionMaterials         |
| Cooling                       |
| CurrentFinancing              |
| CurrentUse                    |
| DevelopmentStatus             |
| Disclosures                   |
| DocumentsAvailable            |
| Electric                      |
| ExistingLeaseType             |
| ExteriorFeatures              |
| Fencing                       |
| FinancialDataSource           |
| FireplaceFeatures             |
| Flooring                      |
| FoundationDetails             |
| FrontageType                  |
| GreenBuildingVerificationType |
| GreenEnergyEfficient          |
| GreenEnergyGeneration         |
| GreenIndoorAirQuality         |
| GreenSustainability           |
| GreenWaterConservation        |
| Heating                       |
| HorseAmenities                |
| HoursDaysOfOperation          |
| InteriorFeatures              |
| IrrigationSource              |
| LaundryFeatures               |
| Levels                        |
| ListAgentDesignation          |
| ListingTerms                  |
| LockBoxType                   |
| LotFeatures                   |
| OperatingExpenseIncludes      |
| OtherEquipment                |
| OtherStructures               |
| OwnerPays                     |
| ParkingFeatures               |
| PatioAndPorchFeatures         |
| PetsAllowed                   |
| PoolFeatures                  |
| Possession                    |
| PossibleUse                   |
| PowerProductionType           |
| PropertyCondition             |
| RentIncludes                  |
| RoadFrontageType              |
| RoadResponsibility            |
| RoadSurfaceType               |
| Roof                          |
| RoomType                      |
| SecurityFeatures              |
| Sewer                         |
| ShowingContactType            |
| ShowingRequirements           |
| Skirt                         |
| SpaFeatures                   |
| SpecialLicenses               |
| SpecialListingConditions      |
| StructureType                 |
| SyndicateTo                   |
| TenantPays                    |
| UnitTypeType                  |
| Utilities                     |
| Vegetation                    |
| View                          |
| WaterfrontFeatures            |
| WaterSource                   |
| WindowFeatures                |

#### Media <a href="#media" id="media"></a>

​Permission

#### Rooms <a href="#rooms" id="rooms"></a>

​RoomFeatures

#### Member <a href="#member" id="member"></a>

​SyndicateTo

#### Office <a href="#office" id="office"></a>

​SyndicateTo

## Appendix <a href="#appendix" id="appendix"></a>

This includes other information that might be important to better understand the MLS Grid service.

### Example Property Data <a href="#example-property-data" id="example-property-data"></a>

Here is an example of a single property record from Actris:

```javascript
{
    "@odata.id": "https://api-demo.mlsgrid.com/v2/Property('ACT107472571')",
    "AccessibilityFeatures": [
        "Customized Wheelchair Accessible"
    ],
    "ACT_ActiveOpenHouseCount": "0",
    "AdditionalParcelsYN": false,
    "Appliances": [
        "Built-In Gas Oven",
        "Built-In Gas Range",
        "Dishwasher",
        "Microwave"
    ],
    "AssociationYN": false,
    "BathroomsFull": 3,
    "BathroomsHalf": 0,
    "BathroomsTotalInteger": 3,
    "BedroomsTotal": 4,
    "BuyerAgencyCompensation": "3.000",
    "BuyerAgencyCompensationType": "%",
    "BuyerOfficeKey": "ACT1513635",
    "CoBuyerOfficeKey": "ACT1513635",
    "CommunityFeatures": [
        "None"
    ],
    "ConstructionMaterials": [
        "HardiPlank Type"
    ],
    "Cooling": [
        "Ceiling Fan(s)",
        "Central Air"
    ],
    "CountyOrParish": "Williamson",
    "CoveredSpaces": 0,
    "DirectionFaces": "East",
    "Disclosures": [
        "Owner/Agent"
    ],
    "ACT_ElementaryOther": "Gateway College Prep",
    "ElementarySchool": "Jo Ann Ford",
    "ACT_EstimatedTaxes": "4934.00",
    "ACT_ETJExtraTerritorialJurdn": "No",
    "ExteriorFeatures": [
        "None"
    ],
    "ACT_FEMAFloodPlain": "No",
    "Fencing": [
        "Back Yard",
        "Front Yard"
    ],
    "FireplacesTotal": 0,
    "Flooring": [
        "Vinyl"
    ],
    "FoundationDetails": [
        "Slab"
    ],
    "GarageSpaces": 0,
    "GreenEnergyEfficient": [
        "None"
    ],
    "GreenSustainability": [
        "None"
    ],
    "ACT_GuestAccommodatonDesc": "None",
    "Heating": [
        "Central"
    ],
    "HighSchool": "East View",
    "HorseAmenities": [
        "None"
    ],
    "HorseYN": false,
    "ACT_IDXOptInYN": "1",
    "InteriorFeatures": [
        "Ceiling Fan(s)",
        "Beamed Ceilings",
        "Gas Dryer Hookup",
        "Kitchen Island",
        "Multiple Dining Areas",
        "No Interior Steps",
        "Open Floorplan",
        "Primary Bedroom on Main",
        "Washer Hookup"
    ],
    "InternetAddressDisplayYN": true,
    "InternetAutomatedValuationDisplayYN": false,
    "InternetConsumerCommentYN": false,
    "InternetEntireListingDisplayYN": true,
    "ACT_LastChangeTimestamp": "2020-12-05T15:32:42.710",
    "ACT_LastChangeType": "Price Decrease",
    "ACT_LastHumanModificationTimestamp": "2020-12-05T15:41:31.400",
    "ACT_LaundryLocation": "Main Level",
    "Levels": [
        "One"
    ],
    "ListAgentAOR": "Austin Board Of Realtors",
    "ListAgentDirectPhone": "(512) 400-0188",
    "ListAgentEmail": "michael.villanueva@cbunited.com",
    "ListAgentFullName": "Michael Villanueva",
    "ListAgentKey": "ACT31371801",
    "ListAgentMlsId": "ACT717866",
    "ListAOR": "Austin Board Of Realtors",
    "ListingContractDate": "2020-10-10",
    "ListingId": "ACT1475089",
    "ListingKey": "ACT107472571",
    "ListOfficeKey": "ACT1513635",
    "ListOfficeMlsId": "ACT024R11",
    "ListOfficeName": "Coldwell Banker Realty",
    "ListOfficePhone": "(512) 233-4868",
    "ListPrice": 474800,
    "LivingArea": 2400,
    "LivingAreaSource": "Public Records",
    "LotFeatures": [
        "Back Yard",
        "Trees-Moderate"
    ],
    "LotSizeAcres": 0.223,
    "LotSizeSquareFeet": 9713.88,
    "MainLevelBedrooms": 4,
    "MajorChangeTimestamp": "2020-12-05T21:32:42.000Z",
    "MajorChangeType": "Price Decrease",
    "MiddleOrJuniorSchool": "James Tippit",
    "MLSAreaMajor": "GTE",
    "MlsStatus": "Active",
    "NewConstructionYN": false,
    "ACT_NumDining": "1",
    "ACT_NumLiving": "1",
    "ACT_OpenHouseCount": "2",
    "ACT_OpenHousePublicCount": "0",
    "OriginalEntryTimestamp": "2020-10-10T16:11:01.000Z",
    "OriginalListPrice": 490000,
    "OriginatingSystemName": "actris",
    "OtherStructures": [
        "See Remarks"
    ],
    "ParcelNumber": "20956500000001",
    "ParkingFeatures": [
        "Carport"
    ],
    "ParkingTotal": 4,
    "PatioAndPorchFeatures": [
        "Front Porch"
    ],
    "PoolFeatures": [
        "None"
    ],
    "PoolPrivateYN": false,
    "PreviousListPrice": 479800,
    "PropertyCondition": [
        "Resale",
        "Updated/Remodeled"
    ],
    "PropertySubType": "Single Family Residence",
    "PropertyType": "Residential",
    "PublicRemarks": "Come see this gorgeous remodel in the heart of Georgetown. With so many modern updates, you're sure to feel right at home here. New chef's kitchen with custom maple cabinets and Calacatta quartz countertops. Vinyl plank flooring throughout living room, kitchen and bedrooms. Beautiful spa-like bathrooms. 36\" doorways in main spaces and master bedroom/bathroom. New HVAC and roof. Large curved driveway with a carport for plenty of parking. Extra 1100 sqft building could accommodate yoga studio, office or storage space. Schedule your in person showing today while its still available.",
    "Roof": [
        "Shingle"
    ],
    "Sewer": [
        "Public Sewer"
    ],
    "SpaFeatures": [
        "None"
    ],
    "SpecialListingConditions": [
        "Standard"
    ],
    "StandardStatus": "Active",
    "ACT_StatusContractualSearchDate": "2020-10-10",
    "SubAgencyCompensation": "0.000",
    "SubAgencyCompensationType": "%",
    "SubdivisionName": "Santos Alfredo Add",
    "SyndicateTo": [
        "AustinHomeSearch.com",
        "Homes.com",
        "HomeSnap",
        "ListHub",
        "Realtor.com",
        "Zillow/Trulia"
    ],
    "SyndicationRemarks": "Come see this gorgeous remodel in the heart of Georgetown. With so many modern updates, you're sure to feel right at home here. New chef's kitchen with custom maple cabinets and Calacatta quartz countertops. Vinyl plank flooring throughout living room, kitchen and bedrooms. Beautiful spa-like bathrooms. 36\" doorways in main spaces and master bedroom/bathroom. New HVAC and roof. Large curved driveway with a carport for plenty of parking. Extra 1100 sqft building could accommodate yoga studio, office or storage space. Schedule your in person showing today while its still available.",
    "TaxAssessedValue": 272970,
    "ACT_TaxFilledSqftTotal": "2400",
    "TaxLegalDescription": "S7204 - SANTOS ALFREDO ADDITION, LOT 1, ACRES 0.2228",
    "TaxMapNumber": "1",
    "TaxYear": 2020,
    "ACT_UnitStyle": "Single level Floor Plan",
    "Utilities": [
        "Electricity Available",
        "Natural Gas Available"
    ],
    "View": [
        "None"
    ],
    "VirtualTourURLUnbranded": "https://urldefense.com/v3/__https://my.matterport.com/show/?m=cRYqFavkw8n__;!!CHCva4lQ!VDwYj-9CwLFe61gcSnd0SuHeBnOOVVy0t_uibk_rT6Eyw5Lz2b9tDvuCnAk2We0m8hAAU5hb$",
    "WaterfrontFeatures": [
        "None"
    ],
    "WaterfrontYN": false,
    "WaterSource": [
        "Public"
    ],
    "WindowFeatures": [
        "Double Pane Windows"
    ],
    "YearBuilt": 1999,
    "YearBuiltSource": "Public Records",
    "ModificationTimestamp": "2021-12-09T00:11:06.174Z",
    "PhotosCount": 24,
    "PhotosChangeTimestamp": "2021-01-13T23:00:11.562Z",
    "City": "Georgetown",
    "Country": "US",
    "Directions": "From Austin, take N Interstate 35 Frontage Rd in Georgetown, Take exit 261 from I-35 N Continue on N Interstate 35 Frontage Rd, Take TX-29 E/W University Ave to Timber St",
    "Latitude": 30.630497,
    "Longitude": -97.680934,
    "PostalCode": "78626",
    "StateOrProvince": "TX",
    "StreetName": "Timber",
    "StreetNumber": "1506",
    "StreetNumberNumeric": 1506,
    "StreetSuffix": "ST",
    "UnparsedAddress": "1506  Timber St  ",
    "MlgCanView": true
}
```